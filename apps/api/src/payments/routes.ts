import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { requireUser, type SessionUser } from "../auth/session.js";
import { loadAccessTokenForUser } from "../auth/oauth.js";
import { advanceRoomAfterStakes } from "../game/engine.js";
import { getGameModule } from "../game/registry.js";
import { ethToWei } from "../game/settlement.js";
import { broadcastState } from "../realtime/hub.js";
import { applyIntentTransition, findReusablePendingIntent, getIntent, recordIntent } from "./intents.js";
import { fetchPaymentLimits, fetchPaymentPrice, getIntentStatus, requestCharge, TtgError } from "./oauth-client.js";

export const paymentsRoutes = new Hono<{ Variables: { user: SessionUser } }>();

paymentsRoutes.use("*", requireUser);

const chargeSchema = z.object({ roomId: z.string().min(1) });

// POST /payments/charge -- create a charge intent for a room stake. chain/token from env, amount
// from the room's stakeEth. Returns `completed` (silent offline) or `redirect` (send the user to
// TTG's /pay page). Either way a local intent row is recorded so the events socket can map
// intentId -> room when TTG pushes lifecycle transitions.
paymentsRoutes.post("/charge", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = chargeSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "bad_request", issues: parsed.error.issues }, 400);

    const user = c.get("user");
    const rooms = await db.select().from(schema.rooms).where(eq(schema.rooms.id, parsed.data.roomId)).limit(1);
    const room = rooms[0];
    if (!room) return c.json({ error: "room_not_found" }, 404);

    const isHost = room.hostUserId === user.id;
    const isGuest = room.guestUserId === user.id;
    if (!isHost && !isGuest) return c.json({ error: "not_a_participant" }, 403);

    const expectedStatus = isHost ? "awaiting_host_stake" : "awaiting_guest_stake";
    if (room.status !== expectedStatus) {
        return c.json({ error: "stake_not_required", roomStatus: room.status }, 409);
    }

    const tokenRow = await loadAccessTokenForUser(user.id);
    if (!tokenRow) return c.json({ error: "missing_access_token" }, 401);
    if (!tokenRow.scope.split(/\s+/u).includes("payments:charge")) {
        return c.json({ error: "scope_insufficient", required: "payments:charge" }, 403);
    }

    const amountWei = ethToWei(room.stakeEth).toString();
    const returnUri = `${env.WEB_ORIGIN}/payment-return?roomId=${encodeURIComponent(room.id)}`;
    const gameName = getGameModule(room.gameId)?.displayName ?? room.gameId;

    // Idempotency: reuse a still-pending intent's key so a re-click triggers TTG's replay instead of
    // minting a second intent + cap reservation.
    const reusable = await findReusablePendingIntent({ roomId: room.id, userId: user.id, now: Date.now() });
    const idempotencyKey = reusable?.idempotencyKey ?? randomUUID();

    let response;
    try {
        response = await requestCharge({
            bearer: tokenRow.accessToken,
            idempotencyKey,
            body: {
                chain: env.PAYMENT_CHAIN,
                amount: amountWei,
                token: env.PAYMENT_TOKEN as `0x${string}`,
                returnUri,
                ...(room.potId ? { potId: room.potId } : {}),
                metadata: {
                    purpose: "entry_fee",
                    title: `${gameName} stake`,
                    note: `Stake for ${gameName} room ${room.id}`,
                    sessionId: room.id,
                    extra: { roomId: room.id, gameId: room.gameId, stakeEth: room.stakeEth, seat: isHost ? "host" : "guest" },
                },
            },
        });
    } catch (e) {
        if (e instanceof TtgError) {
            if (e.status === 422 && e.code === "idempotency_key_reused") {
                return c.json({ error: "ttg_idempotency_mismatch", status: 422 }, 502);
            }
            return c.json({ error: "ttg_charge_failed", code: e.code, status: e.status }, 502);
        }
        throw e;
    }

    if (response.status === "monthly_limit_exceeded") {
        return c.json(
            {
                status: "monthly_limit_exceeded" as const,
                currentLimitCents: response.currentLimitCents,
                monthSpentCents: response.monthSpentCents,
                attemptedUsdCents: response.attemptedUsdCents,
                redirectUrl: response.redirectUrl,
            },
            402,
        );
    }

    // 5min TTL mirrors TTG's intent TTL. The redirect path uses this for the backstop poll.
    const expiresAt = Date.now() + 5 * 60 * 1000;
    if (response.status === "completed") {
        await recordIntent({
            intentId: response.intentId,
            roomId: room.id,
            userId: user.id,
            usdCents: response.usdCents,
            chain: env.PAYMENT_CHAIN,
            expiresAt,
            initialStatus: "completed",
            idempotencyKey,
            paymentId: response.paymentId,
            txHash: response.txHash,
        });
        const advanced = await advanceRoomAfterStakes(room.id);
        if (advanced) await broadcastState(room.id);
        return c.json({ status: "completed", intentId: response.intentId });
    }

    await recordIntent({
        intentId: response.intentId,
        roomId: room.id,
        userId: user.id,
        usdCents: response.usdCents,
        chain: env.PAYMENT_CHAIN,
        expiresAt,
        initialStatus: "pending",
        idempotencyKey,
    });
    return c.json({
        status: "redirect",
        intentId: response.intentId,
        redirectUrl: response.redirectUrl,
        usdCents: response.usdCents,
    });
});

// GET /payments/preflight/:roomId -- bundle limits + a stake price quote so the web can render USD
// usage and decide whether to surface a "raise cap" CTA before the user clicks pay.
paymentsRoutes.get("/preflight/:roomId", async (c) => {
    const user = c.get("user");
    const rooms = await db.select().from(schema.rooms).where(eq(schema.rooms.id, c.req.param("roomId"))).limit(1);
    const room = rooms[0];
    if (!room) return c.json({ error: "room_not_found" }, 404);
    if (room.hostUserId !== user.id && room.guestUserId !== user.id) {
        return c.json({ error: "not_a_participant" }, 403);
    }

    const tokenRow = await loadAccessTokenForUser(user.id);
    if (!tokenRow) return c.json({ error: "missing_access_token" }, 401);
    if (!tokenRow.scope.split(/\s+/u).includes("payments:charge")) {
        return c.json({ error: "scope_insufficient", required: "payments:charge" }, 403);
    }

    const amountWei = ethToWei(room.stakeEth).toString();
    const [limitsResult, priceResult] = await Promise.allSettled([
        fetchPaymentLimits({ bearer: tokenRow.accessToken }),
        fetchPaymentPrice({
            bearer: tokenRow.accessToken,
            chain: env.PAYMENT_CHAIN,
            token: env.PAYMENT_TOKEN as `0x${string}`,
            amount: amountWei,
        }),
    ]);
    if (limitsResult.status === "rejected") {
        const e = limitsResult.reason;
        if (e instanceof TtgError) return c.json({ error: "ttg_limits_failed", code: e.code, status: e.status }, 502);
        throw e;
    }
    if (priceResult.status === "rejected") {
        const e = priceResult.reason;
        if (e instanceof TtgError) return c.json({ error: "ttg_price_failed", code: e.code, status: e.status }, 502);
        throw e;
    }
    const limits = limitsResult.value;
    const price = priceResult.value;
    const usdCents = price.usdCents ?? 0;

    return c.json({
        stake: { roomId: room.id, stakeEth: room.stakeEth, amountWei, usdCents, usdRate: price.usdRate },
        limits: {
            monthlyLimitCents: limits.monthlyLimitCents,
            monthSpentCents: limits.monthSpentCents,
            periodStart: limits.periodStart,
            offlineAutoChargeEnabled: limits.offlineAutoChargeEnabled,
            perTxOfflineCapCents: limits.perTxOfflineCapCents,
        },
        derived: {
            remainingCents:
                limits.monthlyLimitCents === null
                    ? null
                    : Math.max(0, limits.monthlyLimitCents - limits.monthSpentCents),
            willExceedCap:
                limits.monthlyLimitCents !== null && limits.monthSpentCents + usdCents > limits.monthlyLimitCents,
            willChargeInstantly:
                limits.offlineAutoChargeEnabled &&
                limits.perTxOfflineCapCents !== null &&
                usdCents <= limits.perTxOfflineCapCents,
        },
    });
});

function serializeIntent(row: NonNullable<Awaited<ReturnType<typeof getIntent>>>) {
    return {
        id: row.id,
        roomId: row.roomId,
        status: row.status,
        paymentId: row.paymentId,
        txHash: row.txHash,
        usdCents: row.usdCents,
        chain: row.chain,
        resolvedAt: row.resolvedAt,
        createdAt: row.createdAt,
    };
}

// GET /payments/intent/:id -- local snapshot for the /payment-return page.
paymentsRoutes.get("/intent/:id", async (c) => {
    const user = c.get("user");
    const row = await getIntent(c.req.param("id"));
    if (!row || row.userId !== user.id) return c.json({ error: "intent_not_found" }, 404);
    return c.json({ intent: serializeIntent(row) });
});

// POST /payments/intent/:id/sync -- belt-and-suspenders poll of TTG on the return landing.
paymentsRoutes.post("/intent/:id/sync", async (c) => {
    const user = c.get("user");
    const intentId = c.req.param("id");
    const row = await getIntent(intentId);
    if (!row || row.userId !== user.id) return c.json({ error: "intent_not_found" }, 404);
    if (row.status !== "pending") return c.json({ intent: serializeIntent(row), changed: false });

    const tokenRow = await loadAccessTokenForUser(user.id);
    if (!tokenRow) return c.json({ error: "missing_access_token" }, 401);

    let upstream;
    try {
        upstream = await getIntentStatus({ bearer: tokenRow.accessToken, intentId });
    } catch (e) {
        if (e instanceof TtgError) return c.json({ error: "ttg_status_failed", code: e.code, status: e.status }, 502);
        throw e;
    }
    if (upstream.status === "pending") return c.json({ intent: serializeIntent(row), changed: false });

    const updated = await applyIntentTransition({
        intentId,
        nextStatus: upstream.status,
        paymentId: upstream.paymentId,
        txHash: upstream.txHash,
        resolvedAt: Date.now(),
    });
    if (updated?.status === "completed") {
        const advanced = await advanceRoomAfterStakes(updated.roomId);
        if (advanced) await broadcastState(updated.roomId);
    }
    return c.json({ intent: serializeIntent(updated ?? row), changed: updated !== null });
});
