import { defineGame, type GameEvent, type Outcome, type Seat } from "@game-kit/game-core";
import {
    coinflipConfig,
    coinflipMove,
    coinflipState,
    type CoinflipMove,
    type CoinflipState,
    type CoinflipView,
    type Side,
} from "./schema.js";

const SIDES: readonly Side[] = ["heads", "tails"];

export const coinflip = defineGame<CoinflipState, CoinflipMove, { rounds: number }>({
    id: "coinflip",
    displayName: "Coin-Flip Duel",
    description:
        "Both players secretly pick heads or tails; the server flips one coin per round. Match the flip when your opponent doesn't to win the round. Most rounds after the set wins the pot.",

    schema: { state: coinflipState, move: coinflipMove, config: coinflipConfig },
    defaultConfig: { rounds: 3 },

    createInitialState({ config }) {
        return {
            rounds: config.rounds,
            round: 1,
            phase: "picking",
            picks: { host: null, guest: null },
            wins: { host: 0, guest: 0 },
            history: [],
        };
    },

    // Both staked; nothing to deal -- round 1 is already open from createInitialState.
    start(state) {
        return state;
    },

    validateMove(state, _move, ctx) {
        if (state.phase !== "picking") return { ok: false, code: "not_accepting_picks" };
        if (state.picks[ctx.by] !== null) return { ok: false, code: "already_picked" };
        return { ok: true };
    },

    applyMove(state, move, ctx) {
        const picks = { ...state.picks, [ctx.by]: move.pick };

        // Wait for the other seat before resolving.
        if (picks.host === null || picks.guest === null) {
            return { state: { ...state, picks } };
        }

        const flip = ctx.rng.pick(SIDES);
        const hostMatch = picks.host === flip;
        const guestMatch = picks.guest === flip;
        const winner: Seat | null =
            hostMatch && !guestMatch ? "host" : guestMatch && !hostMatch ? "guest" : null;

        const wins = {
            host: state.wins.host + (winner === "host" ? 1 : 0),
            guest: state.wins.guest + (winner === "guest" ? 1 : 0),
        };
        const resolved = { round: state.round, flip, picks: { host: picks.host, guest: picks.guest }, winner };
        const history = [...state.history, resolved];

        const isLast = state.round >= state.rounds;
        const next: CoinflipState = {
            ...state,
            picks: { host: null, guest: null },
            wins,
            history,
            round: isLast ? state.round : state.round + 1,
            phase: isLast ? "complete" : "picking",
        };

        const events: GameEvent[] = [{ kind: "round_resolved", round: resolved.round, flip, picks: resolved.picks, winner }];
        return { state: next, events };
    },

    isComplete(state) {
        return state.phase === "complete";
    },

    outcome(state): Outcome {
        if (state.phase !== "complete") return { kind: "pending" };
        if (state.wins.host > state.wins.guest) return { kind: "win", winner: "host" };
        if (state.wins.guest > state.wins.host) return { kind: "win", winner: "guest" };
        return { kind: "draw" };
    },

    view(state, viewer): CoinflipView {
        const opponent: Seat = viewer === "host" ? "guest" : "host";
        return {
            rounds: state.rounds,
            round: state.round,
            phase: state.phase,
            wins: { you: state.wins[viewer], opponent: state.wins[opponent] },
            yourPick: state.picks[viewer],
            opponentSubmitted: state.picks[opponent] !== null,
            history: state.history,
        };
    },

    // No settlement() override -> the engine uses its default: winner takes the full pot, a draw
    // refunds both players their stake.
});
