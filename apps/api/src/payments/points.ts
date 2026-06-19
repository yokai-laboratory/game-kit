import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";

// The "store": one-way purchases that grant in-game points. This is the second shape of TTG payment
// in the kit, alongside pot stakes:
//
//   pot stake   -> money into a shared CreditVault pot, paid back out by distributePot on settle.
//   purchase    -> money one-way to the app's payout wallet; nothing is escrowed or refunded.
//
// A purchase is the pattern for selling soft currency, cosmetics, or any inventory: charge once,
// then grant something in app state. Here "something" is a points balance on the user row. Real
// inventory would be its own table, but the money path is identical.

export interface PointPack {
    readonly id: string;
    readonly points: number;
    // Plain ETH string (like a room's stakeEth); TTG converts to wei + USD at charge time.
    readonly priceEth: string;
    readonly title: string;
}

// The buyable catalog. Defined server-side (the client fetches it via GET /payments/points) so price
// and grant can never be tampered with from the browser.
export const POINT_PACKS: readonly PointPack[] = [
    { id: "starter", points: 100, priceEth: "0.005", title: "Starter pack" },
    { id: "stack", points: 500, priceEth: "0.02", title: "Stack" },
    { id: "whale", points: 1500, priceEth: "0.05", title: "Whale chest" },
];

export function getPointPack(id: string): PointPack | undefined {
    return POINT_PACKS.find((pack) => pack.id === id);
}

export async function getUserPoints(userId: string): Promise<number> {
    const rows = await db
        .select({ points: schema.users.points })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
    return rows[0]?.points ?? 0;
}

// Idempotently credit a completed purchase intent's points to its buyer. The guarded UPDATE claims
// the row (kind=purchase AND status=completed AND not-yet-credited) in one atomic step, so whichever
// completion path observes the intent first -- the charge response, the events socket, the poll
// backstop, or the return-page sync -- credits exactly once; the rest no-op. Returns the buyer's new
// balance when it credited, or null when there was nothing to do.
export async function creditPurchaseIfCompleted(intentId: string): Promise<number | null> {
    // better-sqlite3 transactions are synchronous: the callback runs to completion inside one
    // BEGIN/COMMIT and the tx query builders return results directly (no await). The guarded UPDATE
    // still claims-or-noops atomically, so the once-only credit semantics are unchanged.
    return db.transaction((txn) => {
        const claimed = txn
            .update(schema.oauthPaymentIntents)
            .set({ pointsCredited: true })
            .where(
                and(
                    eq(schema.oauthPaymentIntents.id, intentId),
                    eq(schema.oauthPaymentIntents.kind, "purchase"),
                    eq(schema.oauthPaymentIntents.status, "completed"),
                    eq(schema.oauthPaymentIntents.pointsCredited, false),
                    isNotNull(schema.oauthPaymentIntents.creditPoints),
                ),
            )
            .returning()
            .all();
        const row = claimed[0];
        if (!row || row.creditPoints === null) return null;
        const updated = txn
            .update(schema.users)
            .set({ points: sql`${schema.users.points} + ${row.creditPoints}` })
            .where(eq(schema.users.id, row.userId))
            .returning({ points: schema.users.points })
            .all();
        return updated[0]?.points ?? null;
    });
}
