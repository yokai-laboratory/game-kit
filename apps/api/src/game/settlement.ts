import { eq } from "drizzle-orm";
import type { AnyGameModule, Outcome, Seat } from "@game-kit/game-core";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { requestDistribute, TronError } from "../payments/oauth-client.js";
import { tronClient } from "../payments/tron-client.js";
import { tronToCents } from "../payments/units.js";

// 18 decimals for native ETH + the in-scope stablecoins. ERC-20s with other decimals would need a
// per-token decimals lookup; the template assumes 18 (matches TRON's anvil-local + ETH).
const ETH_DECIMALS = 18n;

export function ethToWei(eth: string): bigint {
    const [whole, frac = ""] = eth.split(".");
    const fracPadded = (frac + "0".repeat(Number(ETH_DECIMALS))).slice(0, Number(ETH_DECIMALS));
    return BigInt(whole ?? "0") * 10n ** ETH_DECIMALS + BigInt(fracPadded === "" ? "0" : fracPadded);
}

const PROVIDER_PREFIX = `${env.OAUTH_PROVIDER_NAME}:`;

async function resolveTronUserId(localUserId: string): Promise<string | null> {
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
// completed transition (the operator can re-settle the pot manually if TRON's relay reverted).
export async function settleRoom(input: {
    roomId: string;
    potId: string | null;
    stakeEth: string;
    // "eth" settles the on-chain CreditVault pot via distributePot (legs in wei); "tron" settles the
    // TRON ledger pot via tronDistribute (legs in cents). The leg *shares* are identical -- only the
    // denomination and the settlement call differ.
    currency: "eth" | "tron";
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

    // Legs are always computed in wei (the GameModule's settlement() override + the engine default
    // speak wei). For the TRON rail we scale each leg to ledger cents by the stake's cents:wei ratio,
    // so a custom split is preserved across either denomination (winner=2x stake -> 2x stakeCents).
    const stakeCents = tronToCents(input.stakeEth);
    const weiToCents = (wei: bigint): number =>
        stakeWei === 0n ? 0 : Number((wei * BigInt(stakeCents)) / stakeWei);

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
    const isWin = input.outcome.kind === "win";

    // Resolve each leg's local user to its TRON user id, dropping unresolvable legs (fail-soft).
    const resolved: { seat: Seat; tronUserId: string; amountWei: bigint }[] = [];
    for (const leg of legsBySeat) {
        const localUserId = seatUserId(leg.seat);
        if (localUserId === null) continue;
        const tronUserId = await resolveTronUserId(localUserId);
        if (tronUserId === null) {
            logger.warn({ roomId: input.roomId, seat: leg.seat }, "settle: leg skipped (unresolvable user)");
            continue;
        }
        resolved.push({ seat: leg.seat, tronUserId, amountWei: leg.amountWei });
    }
    if (resolved.length === 0) {
        logger.warn({ roomId: input.roomId }, "settle: no resolvable legs, pot left intact");
        return;
    }

    try {
        if (input.currency === "tron") {
            const response = await tronClient.payments.tronDistribute({
                // Room-scoped key: a re-settle attempt replays instead of double-paying.
                idempotencyKey: `dist-${input.roomId}`,
                body: {
                    potId: input.potId,
                    legs: resolved.map((l) => ({ recipientUserId: l.tronUserId, amountCents: weiToCents(l.amountWei) })),
                    devCutCents: 0,
                    closePot: true,
                    // Same bundle key (room id) the TRON stakes carry, so every leg clusters as one
                    // story on the feed. Refund legs read as a refund, wins as winnings.
                    metadata: {
                        groupId: input.roomId,
                        purpose: isWin ? "reward" : "refund",
                        title: `${input.gameDisplayName} ${isWin ? "winnings" : "refund"}`,
                    },
                },
            });
            logger.info({ roomId: input.roomId, status: response.status }, "settle: TRON pot distributed");
            return;
        }
        const response = await requestDistribute({
            chain: env.PAYMENT_CHAIN,
            token: env.PAYMENT_TOKEN as `0x${string}`,
            potId: input.potId,
            closePot: true,
            legs: resolved.map((l) => ({ recipientUserId: l.tronUserId, amount: l.amountWei.toString() })),
            metadata: {
                purpose: isWin ? "reward" : "refund",
                title: `${input.gameDisplayName} ${isWin ? "winnings" : "refund"}`,
                note: `${isWin ? "Winnings from" : "Refund from"} ${input.gameDisplayName} room ${input.roomId}`,
                groupId: input.roomId,
                sessionId: input.roomId,
                extra: { roomId: input.roomId, outcome: input.outcome.kind, legs: resolved.length },
            },
        });
        logger.info(
            { roomId: input.roomId, distributionId: response.distributionId, txHash: response.txHash },
            "settle: pot distributed",
        );
    } catch (error) {
        const reason = error instanceof TronError ? `${error.status} ${error.code}` : (error as Error).message;
        logger.warn({ roomId: input.roomId, potId: input.potId, reason }, "settle: distribution failed");
    }
}
