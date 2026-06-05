import { z } from "zod";

// ── Coin-flip duel ───────────────────────────────────────────────────────────
// Two players each secretly pick a side. The server flips one coin per round. A player wins the
// round if their pick matches the flip and their opponent's does not; if both match or both miss
// it's a push (no winner) but the round still counts. After `rounds` rounds the higher win count
// takes the pot; a tie refunds both. Hidden simultaneous picks = the primitive worth keeping;
// the coin mechanic itself is the throwaway part.

export const side = z.enum(["heads", "tails"]);
export type Side = z.infer<typeof side>;

export const coinflipConfig = z.object({
    // total rounds played (odd avoids most ties but pushes can still force a draw). Required here;
    // the engine fills it from the module's defaultConfig when a create request omits it.
    rounds: z.number().int().min(1).max(9),
});
export type CoinflipConfig = z.infer<typeof coinflipConfig>;

export const coinflipMove = z.object({
    pick: side,
});
export type CoinflipMove = z.infer<typeof coinflipMove>;

export const resolvedRound = z.object({
    round: z.number().int(),
    flip: side,
    picks: z.object({ host: side, guest: side }),
    // null = push (both matched or both missed the flip)
    winner: z.enum(["host", "guest"]).nullable(),
});
export type ResolvedRound = z.infer<typeof resolvedRound>;

export const coinflipState = z.object({
    rounds: z.number().int(),
    round: z.number().int(),
    phase: z.enum(["picking", "complete"]),
    picks: z.object({ host: side.nullable(), guest: side.nullable() }),
    wins: z.object({ host: z.number().int(), guest: z.number().int() }),
    history: z.array(resolvedRound),
});
export type CoinflipState = z.infer<typeof coinflipState>;

// What a single client receives (opponent's live pick is redacted until the round resolves).
export interface CoinflipView {
    rounds: number;
    round: number;
    phase: "picking" | "complete";
    wins: { you: number; opponent: number };
    yourPick: Side | null;
    opponentSubmitted: boolean;
    history: ResolvedRound[];
}
