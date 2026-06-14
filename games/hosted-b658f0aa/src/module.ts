import { defineGame, type Outcome, type Seat } from "@game-kit/game-core";
// The hosted module, verbatim. Its contract: setup/outcome/moves/move pure functions.
// @ts-expect-error -- plain-JS hosted module, typed at the adapter boundary below
import hosted from "./hosted-module.js";
import { stateSchema, moveSchema, configSchema } from "./schema.js";

// Adapter: hosted modules speak userId arrays; game-kit speaks two seats. Seat order is the
// players array order (host first), so outcomes map mechanically.
type State = { players: string[]; [key: string]: unknown };

function seatOf(state: State, userId: string): Seat {
    return state.players[0] === userId ? "host" : "guest";
}

export const hostedB658f0aa = defineGame<State, unknown, Record<string, never>>({
    id: "hosted-b658f0aa",
    displayName: "Twenty-One Dash",
    description: "Two players climb a shared ladder, adding 1-3 each turn. Land on exactly 21 to take the staked pot.",
    schema: { state: stateSchema, move: moveSchema, config: configSchema },
    defaultConfig: {},

    createInitialState({ host }) {
        // Pre-stake placeholder; the real setup runs in start() once both players exist.
        return { players: [host.userId] } as State;
    },
    start(_state, ctx) {
        return hosted.setup({
            players: [ctx.host.userId, ctx.guest.userId],
            seed: ctx.rng.int(0, 2_147_483_647),
        }) as State;
    },
    validateMove(state, move, ctx) {
        // The hosted contract validates by throwing inside move(); probe it without committing.
        const userId = ctx.by === "host" ? state.players[0] : state.players[1];
        try {
            hosted.move(state, userId, move);
            return { ok: true };
        } catch {
            return { ok: false, code: "illegal_move" };
        }
    },
    applyMove(state, move, ctx) {
        const userId = ctx.by === "host" ? state.players[0] : state.players[1];
        return { state: hosted.move(state, userId, move) as State };
    },
    isComplete(state) {
        return hosted.outcome(state) !== null;
    },
    outcome(state) {
        const result = hosted.outcome(state) as { kind: string; winner?: string } | null;
        if (result === null) return { kind: "pending" } as Outcome;
        if (result.kind === "win" && typeof result.winner === "string") {
            return { kind: "win", winner: seatOf(state, result.winner) };
        }
        return { kind: "draw" };
    },
    view(state) {
        // Hosted games broadcast full state (no hidden information in the hosted contract);
        // add per-seat redaction here if your ported game grows secrets.
        return state;
    },
});
