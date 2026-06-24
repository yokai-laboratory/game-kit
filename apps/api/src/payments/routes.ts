import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { requireUser, type SessionUser } from "../auth/session.js";
import { loadAccessTokenForUser } from "../auth/oauth.js";
import { advanceRoomAfterStakes, onIntentResolved } from "../game/engine.js";
import { getGameModule } from "../game/registry.js";
import { ethToWei } from "../game/settlement.js";
import { broadcastState } from "../realtime/hub.js";
import {
    applyIntentTransition,
    findReusablePendingIntent,
    findReusablePendingPurchase,
    getIntent,
    recordIntent,
} from "./intents.js";
import { fetchPaymentLimits, fetchPaymentPrice, getIntentStatus, requestCharge, TronError } from "./oauth-client.js";
import { getPointPack, getUserPoints, POINT_PACKS } from "./points.js";
import { tronClient } from "./tron-client.js";
import { tronToCents } from "./units.js";

export const paymentsRoutes = new Hono<{ Variables: { user: SessionUser } }>();

paymentsRoutes.use("*", requireUser);

const chargeSchema = z.object({ roomId: z.string().min(1) });

// POST /payments/charge -- create a charge intent for a room stake. chain/token from env, amount
// from the room's stakeEth. Returns `completed` (silent offline) or `redirect` (send the user to
// TRON's /pay page). Either way a local intent row is recorded so the events socket can map
// intentId -> room when TRON pushes lifecycle transitions.
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

    const returnUri = `${env.WEB_ORIGIN}/payment-return?roomId=${encodeURIComponent(room.id)}`;
    const gameName = getGameModule(room.gameId)?.displayName ?? room.gameId;

    // TRON rail: a stake at or below the user's per-charge auto-approve cap settles silently
    // (synchronous `completed`); otherwise -- first charge from this app, over the per-charge cap, or
    // over the monthly auto-budget -- TRON returns `redirect` and the user confirms the authoritative
    // amount on the hosted /pay-tron screen. The deterministic (room, user) idempotency key makes a
    // retried request replay TRON's original outcome instead of minting a second intent. This mirrors
    // the ETH rail below, but priced in ledger cents (tronToCents) and settled on TRON's ledger.
    if (room.currency === "tron") {
        if (!room.potId) return c.json({ error: "room_missing_pot" }, 500);
        const amountCents = tronToCents(room.stakeEth);
        const tronIdempotencyKey = `tron-${room.id}-${user.id}`;
        let tronResponse;
        try {
            tronResponse = await tronClient.payments.tronCharge({
                bearer: tokenRow.accessToken,
                idempotencyKey: tronIdempotencyKey,
                body: {
                    potId: room.potId as `0x${string}`,
                    amountCents,
                    // Required: any TRON charge can bounce to the hosted /pay-tron confirm screen,
                    // which returns the user here afterward. Ignored on the silent path.
                    returnUri,
                    // `groupId` (room id) bundles the stakes + the winnings/refund distribution as one
                    // story on the player's TRON activity feed.
                    metadata: {
                        groupId: room.id,
                        sessionId: room.id,
                        purpose: "entry_fee",
                        title: `${gameName} stake`,
                        note: `Stake for ${gameName} room ${room.id}`,
                    },
                },
            });
        } catch (e) {
            if (e instanceof TronError) {
                return c.json({ error: "tron_charge_failed", code: e.code, status: e.status }, 502);
            }
            throw e;
        }
        if (tronResponse.status === "insufficient_balance") {
            // 402, structured like the raise-cap path: the web renders a top-up prompt. The user
            // deposits on TRON (profile -> TRON balance) and retries.
            return c.json(
                { status: "insufficient_tron" as const, balanceCents: tronResponse.balanceCents, requiredCents: amountCents },
                402,
            );
        }
        if (tronResponse.status === "redirect") {
            // Consent redirect: record a pending intent keyed on TRON's intentId so the events socket
            // maps the eventual completed/denied transition back to this room, then hand the web the
            // redirect to navigate to. Mirrors the ETH redirect branch.
            await recordIntent({
                intentId: tronResponse.intentId,
                roomId: room.id,
                userId: user.id,
                usdCents: tronResponse.amountCents,
                chain: "tron",
                expiresAt: Date.now() + 5 * 60 * 1000,
                initialStatus: "pending",
                idempotencyKey: tronIdempotencyKey,
            });
            return c.json({
                status: "redirect",
                intentId: tronResponse.intentId,
                redirectUrl: tronResponse.redirectUrl,
                usdCents: tronResponse.amountCents,
            });
        }
        // Completed (first time or idempotent replay). TRON mints no intent for the silent path, so we
        // fabricate a deterministic local id purely so getCompletedStakeIntents/advanceRoomAfterStakes
        // see this stake like any other; recordIntent's onConflictDoNothing makes the replay a no-op.
        const intentId = `tronintent-${room.id}-${user.id}`;
        await recordIntent({
            intentId,
            roomId: room.id,
            userId: user.id,
            usdCents: amountCents,
            chain: "tron",
            expiresAt: Date.now() + 5 * 60 * 1000,
            initialStatus: "completed",
            idempotencyKey: tronIdempotencyKey,
        });
        const advanced = await advanceRoomAfterStakes(room.id);
        if (advanced) await broadcastState(room.id);
        return c.json({ status: "completed", intentId });
    }

    const amountWei = ethToWei(room.stakeEth).toString();

    // Idempotency: reuse a still-pending intent's key so a re-click triggers TRON's replay instead of
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
                    // `groupId` (room id) bundles the stakes + the winnings/refund distribution as one
                    // story on the player's TRON activity feed; `sessionId` mirrors it as the round marker.
                    groupId: room.id,
                    sessionId: room.id,
                    extra: { roomId: room.id, gameId: room.gameId, stakeEth: room.stakeEth, seat: isHost ? "host" : "guest" },
                },
            },
        });
    } catch (e) {
        if (e instanceof TronError) {
            if (e.status === 422 && e.code === "idempotency_key_reused") {
                return c.json({ error: "tron_idempotency_mismatch", status: 422 }, 502);
            }
            return c.json({ error: "tron_charge_failed", code: e.code, status: e.status }, 502);
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

    // 5min TTL mirrors TRON's intent TTL. The redirect path uses this for the backstop poll.
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

// GET /payments/points -- the player's balance + the buyable packs. Drives the store UI.
paymentsRoutes.get("/points", async (c) => {
    const user = c.get("user");
    const balance = await getUserPoints(user.id);
    return c.json({ balance, packs: POINT_PACKS });
});

const purchaseSchema = z.object({ packId: z.string().min(1) });

// POST /payments/purchase -- buy a point pack. This is a ONE-WAY charge: unlike a stake there is no
// pot and nothing is ever refunded; on completion we credit the pack's points to the buyer. It rides
// the exact same intent machinery as a stake (idempotency key reuse, events socket + poll backstop
// reconciliation for the redirect path) -- the only difference is the recorded intent's `kind`, which
// makes onIntentResolved credit points instead of advancing a room. This is the template for selling
// any in-game inventory on TRON rails.
paymentsRoutes.post("/purchase", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = purchaseSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "bad_request", issues: parsed.error.issues }, 400);

    const user = c.get("user");
    const pack = getPointPack(parsed.data.packId);
    if (!pack) return c.json({ error: "unknown_pack" }, 400);

    const tokenRow = await loadAccessTokenForUser(user.id);
    if (!tokenRow) return c.json({ error: "missing_access_token" }, 401);
    if (!tokenRow.scope.split(/\s+/u).includes("payments:charge")) {
        return c.json({ error: "scope_insufficient", required: "payments:charge" }, 403);
    }

    const amountWei = ethToWei(pack.priceEth).toString();
    // No roomId in the return URI -- the return page bounces store buyers back to /store.
    const returnUri = `${env.WEB_ORIGIN}/payment-return?store=1`;

    const reusable = await findReusablePendingPurchase({ userId: user.id, now: Date.now() });
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
                // No potId: a one-way purchase debits the player; there is no escrow to pay back.
                metadata: {
                    purpose: "store_purchase",
                    title: pack.title,
                    note: `${pack.points} points — ${pack.title}`,
                    quantity: pack.points,
                    category: "points",
                    extra: { packId: pack.id, points: pack.points },
                },
            },
        });
    } catch (e) {
        if (e instanceof TronError) {
            if (e.status === 422 && e.code === "idempotency_key_reused") {
                return c.json({ error: "tron_idempotency_mismatch", status: 422 }, 502);
            }
            return c.json({ error: "tron_charge_failed", code: e.code, status: e.status }, 502);
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

    const expiresAt = Date.now() + 5 * 60 * 1000;
    if (response.status === "completed") {
        const intent = await recordIntent({
            intentId: response.intentId,
            userId: user.id,
            usdCents: response.usdCents,
            chain: env.PAYMENT_CHAIN,
            expiresAt,
            initialStatus: "completed",
            idempotencyKey,
            kind: "purchase",
            creditPoints: pack.points,
            paymentId: response.paymentId,
            txHash: response.txHash,
        });
        await onIntentResolved(intent);
        const balance = await getUserPoints(user.id);
        return c.json({ status: "completed", intentId: response.intentId, points: pack.points, balance });
    }

    await recordIntent({
        intentId: response.intentId,
        userId: user.id,
        usdCents: response.usdCents,
        chain: env.PAYMENT_CHAIN,
        expiresAt,
        initialStatus: "pending",
        idempotencyKey,
        kind: "purchase",
        creditPoints: pack.points,
    });
    return c.json({
        status: "redirect",
        intentId: response.intentId,
        redirectUrl: response.redirectUrl,
        usdCents: response.usdCents,
    });
});

// GET /payments/tron-balance -- the player's spendable TRON ledger balance, proxied through the
// SDK read so the web can render it next to TRON stake affordances and explain an insufficient_tron
// rejection. A null balance means "unavailable" (token missing / scope short / TRON unreachable):
// the web renders a dash instead of failing the lobby, because the figure is advisory -- the charge
// path re-checks for real. `rakeBps` is the app-global house cut TRON carves off a pot's winnings.
paymentsRoutes.get("/tron-balance", async (c) => {
    const user = c.get("user");
    const tokenRow = await loadAccessTokenForUser(user.id);
    if (!tokenRow || !tokenRow.scope.split(/\s+/u).includes("payments:charge")) {
        return c.json({ balanceCents: null, rakeBps: null });
    }
    try {
        const response = await tronClient.payments.tronBalance({ bearer: tokenRow.accessToken });
        return c.json({ balanceCents: response.balanceCents, rakeBps: response.rakeBps });
    } catch {
        return c.json({ balanceCents: null, rakeBps: null });
    }
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

    // TRON rooms have no chain pricing and no monthly-cap interaction: the stake IS ledger cents and
    // the debit is synchronous. Surface the trivial quote in the same shape (usdRate 1:1, no cap
    // pressure) so the web's preflight consumer stays one code path. The web formats it as TRON
    // (1 TRON = 1 cent) based on the room's currency.
    if (room.currency === "tron") {
        const stakeCents = tronToCents(room.stakeEth);
        return c.json({
            stake: { roomId: room.id, stakeEth: room.stakeEth, amountWei: "0", usdCents: stakeCents, usdRate: "1" },
            limits: {
                monthlyLimitCents: null,
                monthSpentCents: 0,
                periodStart: null,
                offlineAutoChargeEnabled: false,
                perTxOfflineCapCents: null,
            },
            derived: { remainingCents: null, willExceedCap: false, willChargeInstantly: false },
        });
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
        if (e instanceof TronError) return c.json({ error: "tron_limits_failed", code: e.code, status: e.status }, 502);
        throw e;
    }
    if (priceResult.status === "rejected") {
        const e = priceResult.reason;
        if (e instanceof TronError) return c.json({ error: "tron_price_failed", code: e.code, status: e.status }, 502);
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
        kind: row.kind,
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

// POST /payments/intent/:id/sync -- belt-and-suspenders poll of TRON on the return landing.
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
        if (e instanceof TronError) return c.json({ error: "tron_status_failed", code: e.code, status: e.status }, 502);
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
    // Dispatch the completion the same way the events socket / poll backstop do: stake -> advance the
    // room, purchase -> credit points. Both idempotent.
    if (updated) await onIntentResolved(updated);
    return c.json({ intent: serializeIntent(updated ?? row), changed: updated !== null });
});
