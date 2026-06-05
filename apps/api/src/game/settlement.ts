import { eq } from "drizzle-orm";
import type { AnyGameModule, Outcome, Seat } from "@game-kit/game-core";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { requestDistribute, TtgError } from "../payments/oauth-client.js";

// 18 decimals for native ETH + the in-scope stablecoins. ERC-20s with other decimals would need a
// per-token decimals lookup; the template assumes 18 (matches TTG's anvil-local + ETH).
const ETH_DECIMALS = 18n;

export function ethToWei(eth: string): bigint {
    const [whole, frac = ""] = eth.split(".");
    const fracPadded = (frac + "0".repeat(Number(ETH_DECIMALS))).slice(0, Number(ETH_DECIMALS));
    return BigInt(whole ?? "0") * 10n ** ETH_DECIMALS + BigInt(fracPadded === "" ? "0" : fracPadded);
}

const PROVIDER_PREFIX = `${env.OAUTH_PROVIDER_NAME}:`;

async function resolveTtgUserId(localUserId: string): Promise<string | null> {
    const rows = await db
        .select({ providerSub: schema.users.providerSub })
        .from(schema.users)
        .where(eq(schema.users.id, localUserId))
        .limit(1);
    const row = rows[0];
    if (!row || !row.providerSub.startsWith(PROVIDER_PREFIX)) return null;
    const id = row.providerSub.slice(PROVIDER_PREFIX.length);
    return id.length === 0 ? null : id;
}

// Settle a finished room's on-chain pot. Legs come from the GameModule's settlement() override, or
// the engine default: winner takes the full pot (2 x stake); a draw refunds each player 1 x stake.
// Fully fail-soft + fire-and-forget -- a settlement hiccup is logged but never blocks the room's
// completed transition (the operator can re-settle the pot manually if TTG's relay reverted).
export async function settleRoom(input: {
    roomId: string;
    potId: string | null;
    stakeEth: string;
    hostUserId: string;
    guestUserId: string | null;
    outcome: Outcome;
    module: AnyGameModule;
    state: unknown;
    gameDisplayName: string;
}): Promise<void> {
    if (!input.potId) return;
    if (input.outcome.kind === "pending") return;

    const stakeWei = ethToWei(input.stakeEth);

    let legsBySeat: { seat: Seat; amountWei: bigint }[];
    if (typeof input.module.settlement === "function") {
        legsBySeat = input.module
            .settlement(input.state, stakeWei)
            .legs.map((l) => ({ seat: l.seat, amountWei: BigInt(l.amountWei) }));
    } else if (input.outcome.kind === "win") {
        legsBySeat = [{ seat: input.outcome.winner, amountWei: stakeWei * 2n }];
    } else {
        // draw -> refund both
        legsBySeat = [{ seat: "host", amountWei: stakeWei }];
        if (input.guestUserId !== null) legsBySeat.push({ seat: "guest", amountWei: stakeWei });
    }

    const seatUserId = (seat: Seat): string | null => (seat === "host" ? input.hostUserId : input.guestUserId);

    try {
        const resolved: { recipientUserId: string; amount: string }[] = [];
        for (const leg of legsBySeat) {
            const localUserId = seatUserId(leg.seat);
            if (localUserId === null) continue;
            const ttgUserId = await resolveTtgUserId(localUserId);
            if (ttgUserId === null) {
                logger.warn({ roomId: input.roomId, seat: leg.seat }, "settle: leg skipped (unresolvable user)");
                continue;
            }
            resolved.push({ recipientUserId: ttgUserId, amount: leg.amountWei.toString() });
        }
        if (resolved.length === 0) {
            logger.warn({ roomId: input.roomId }, "settle: no resolvable legs, pot left intact");
            return;
        }
        const response = await requestDistribute({
            chain: env.PAYMENT_CHAIN,
            token: env.PAYMENT_TOKEN as `0x${string}`,
            potId: input.potId,
            closePot: true,
            legs: resolved,
            metadata: {
                purpose: input.outcome.kind === "win" ? "reward" : "refund",
                title: `${input.gameDisplayName} ${input.outcome.kind === "win" ? "winnings" : "refund"}`,
                note: `${input.outcome.kind === "win" ? "Winnings from" : "Refund from"} ${input.gameDisplayName} room ${input.roomId}`,
                sessionId: input.roomId,
                extra: { roomId: input.roomId, outcome: input.outcome.kind, legs: resolved.length },
            },
        });
        logger.info(
            { roomId: input.roomId, distributionId: response.distributionId, txHash: response.txHash },
            "settle: pot distributed",
        );
    } catch (error) {
        const reason = error instanceof TtgError ? `${error.status} ${error.code}` : (error as Error).message;
        logger.warn({ roomId: input.roomId, potId: input.potId, reason }, "settle: distribution failed");
    }
}
