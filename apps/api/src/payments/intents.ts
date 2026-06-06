import { and, desc, eq, gt, lt } from "drizzle-orm";
import { db, schema } from "../db/client.js";

export type IntentRow = typeof schema.oauthPaymentIntents.$inferSelect;
export type IntentStatusValue = IntentRow["status"];

export type RecordIntentInput = {
    intentId: string;
    // "stake" (set roomId) or "purchase" (set creditPoints, leave roomId null). Defaults to "stake".
    kind?: "stake" | "purchase";
    roomId?: string | null;
    userId: string;
    usdCents: number;
    chain: string;
    expiresAt: number;
    initialStatus: IntentStatusValue;
    // Same key sent in TTG's Idempotency-Key header; stamped so a same-(room,user) re-click while
    // the intent is still pending can reuse it and trigger TTG's replay path.
    idempotencyKey: string;
    // Purchases only: points to grant when the intent completes.
    creditPoints?: number | null;
    paymentId?: string | null;
    txHash?: string | null;
};

export async function recordIntent(input: RecordIntentInput): Promise<IntentRow> {
    const now = Date.now();
    const row: typeof schema.oauthPaymentIntents.$inferInsert = {
        id: input.intentId,
        kind: input.kind ?? "stake",
        roomId: input.roomId ?? null,
        userId: input.userId,
        status: input.initialStatus,
        paymentId: input.paymentId ?? null,
        txHash: input.txHash ?? null,
        usdCents: input.usdCents,
        chain: input.chain,
        idempotencyKey: input.idempotencyKey,
        creditPoints: input.creditPoints ?? null,
        createdAt: now,
        resolvedAt: input.initialStatus === "pending" ? null : now,
        expiresAt: input.expiresAt,
    };
    await db
        .insert(schema.oauthPaymentIntents)
        .values(row)
        .onConflictDoNothing({ target: schema.oauthPaymentIntents.id });
    const fetched = await getIntent(input.intentId);
    if (!fetched) throw new Error(`intent ${input.intentId} vanished after insert`);
    return fetched;
}

// Idempotent transition driven by TTG events / polling. Returns the post-write row on an update,
// null when the row was already terminal. Uses a status='pending' guard so terminal rows are
// immutable -- the one exception is a late tx_hash arriving after the row already flipped to
// completed (the indexer reconciles the Paid event independently).
export async function applyIntentTransition(input: {
    intentId: string;
    nextStatus: IntentStatusValue;
    paymentId?: string | null;
    txHash?: string | null;
    resolvedAt: number;
}): Promise<IntentRow | null> {
    if (input.nextStatus === "completed" && input.txHash !== undefined && input.txHash !== null) {
        const existing = await getIntent(input.intentId);
        if (existing?.status === "completed" && existing.txHash === null) {
            const patched = await db
                .update(schema.oauthPaymentIntents)
                .set({ txHash: input.txHash })
                .where(eq(schema.oauthPaymentIntents.id, input.intentId))
                .returning();
            return patched[0] ?? null;
        }
    }
    const updated = await db
        .update(schema.oauthPaymentIntents)
        .set({
            status: input.nextStatus,
            paymentId: input.paymentId ?? null,
            txHash: input.txHash ?? null,
            resolvedAt: input.resolvedAt,
        })
        .where(
            and(eq(schema.oauthPaymentIntents.id, input.intentId), eq(schema.oauthPaymentIntents.status, "pending")),
        )
        .returning();
    return updated[0] ?? null;
}

export async function getIntent(id: string): Promise<IntentRow | undefined> {
    const rows = await db
        .select()
        .from(schema.oauthPaymentIntents)
        .where(eq(schema.oauthPaymentIntents.id, id))
        .limit(1);
    return rows[0];
}

// "Which players have a completed stake for this room?" -- the gate the engine consults before
// flipping the room to in_progress.
export async function getCompletedStakeIntents(roomId: string): Promise<readonly IntentRow[]> {
    return db
        .select()
        .from(schema.oauthPaymentIntents)
        .where(
            and(eq(schema.oauthPaymentIntents.roomId, roomId), eq(schema.oauthPaymentIntents.status, "completed")),
        );
}

// Polling backstop -- pending intents past their TTG-side TTL. We don't flip them here; the caller
// asks TTG for the canonical state and applies it.
export async function listExpiredPendingIntents(input: { now: number; limit: number }): Promise<readonly IntentRow[]> {
    return db
        .select()
        .from(schema.oauthPaymentIntents)
        .where(and(eq(schema.oauthPaymentIntents.status, "pending"), lt(schema.oauthPaymentIntents.expiresAt, input.now)))
        .limit(input.limit);
}

// Existing pending, not-yet-expired stake intent for (room, user) so a re-click reuses the same key.
export async function findReusablePendingIntent(input: {
    roomId: string;
    userId: string;
    now: number;
}): Promise<IntentRow | null> {
    const rows = await db
        .select()
        .from(schema.oauthPaymentIntents)
        .where(
            and(
                eq(schema.oauthPaymentIntents.roomId, input.roomId),
                eq(schema.oauthPaymentIntents.userId, input.userId),
                eq(schema.oauthPaymentIntents.status, "pending"),
                gt(schema.oauthPaymentIntents.expiresAt, input.now),
            ),
        )
        .orderBy(desc(schema.oauthPaymentIntents.createdAt))
        .limit(1);
    return rows[0] ?? null;
}

// Same idea for store purchases (no room): a pending, not-yet-expired purchase intent for the user so
// a re-click reuses its idempotency key instead of minting a second charge + cap reservation.
export async function findReusablePendingPurchase(input: {
    userId: string;
    now: number;
}): Promise<IntentRow | null> {
    const rows = await db
        .select()
        .from(schema.oauthPaymentIntents)
        .where(
            and(
                eq(schema.oauthPaymentIntents.userId, input.userId),
                eq(schema.oauthPaymentIntents.kind, "purchase"),
                eq(schema.oauthPaymentIntents.status, "pending"),
                gt(schema.oauthPaymentIntents.expiresAt, input.now),
            ),
        )
        .orderBy(desc(schema.oauthPaymentIntents.createdAt))
        .limit(1);
    return rows[0] ?? null;
}
