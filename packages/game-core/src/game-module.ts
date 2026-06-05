import type { ZodType } from "zod";
import type { GameEvent, Seat } from "./protocol.js";

// ─────────────────────────────────────────────────────────────────────────────
// GameModule -- the one interface a new game implements.
//
// THE SEAM: everything in apps/api/src/core and apps/web/src/core (auth, payments, presence,
// the room lifecycle, the Redis-backed socket hub) is a reusable PRIMITIVE you never edit. A game
// is a single folder under games/<id> that implements this interface plus a screen component.
// To build your own game: copy games/coinflip, rewrite the State/Move/engine, done.
//
// The engine drives the lifecycle and calls these pure methods. Keep them deterministic given the
// injected Rng -- never call Math.random()/Date.now() inside a game; take entropy from `rng` and
// timestamps from the engine. That keeps games testable and replayable.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlayerRef {
    userId: string;
    seat: Seat;
    displayName: string;
}

// Injected source of randomness. The server backs this with node:crypto; tests can inject a
// deterministic stub. Games MUST take all entropy from here.
export interface Rng {
    /** uniform integer in [minInclusive, maxExclusive) */
    int(minInclusive: number, maxExclusive: number): number;
    bool(): boolean;
    pick<T>(items: readonly T[]): T;
}

export interface CreateContext<Config> {
    roomId: string;
    host: PlayerRef;
    config: Config;
}

export interface StartContext {
    roomId: string;
    host: PlayerRef;
    guest: PlayerRef;
    rng: Rng;
}

export interface MoveContext {
    roomId: string;
    by: Seat;
    rng: Rng;
}

export type ValidationResult = { ok: true } | { ok: false; code: string };

export type Outcome =
    | { kind: "pending" }
    | { kind: "win"; winner: Seat }
    | { kind: "draw" };

// Optional explicit pot split. Amounts are wei (stringified bigint). When a module omits
// `settlement()` the engine derives the default:
//   win  -> one leg of the full pot (2 x stake) to the winner
//   draw -> two equal legs (1 x stake each), refunding both players
export interface SettlementLeg {
    seat: Seat;
    amountWei: string;
}

export interface Settlement {
    legs: SettlementLeg[];
}

export interface ApplyResult<State> {
    state: State;
    // Broadcast to every participant verbatim (same payload for all viewers). Use for
    // reveal/animation cues; redacted per-seat data belongs in `view()` instead.
    events?: GameEvent[];
}

export interface GameModule<State, Move, Config = Record<string, never>> {
    readonly id: string;
    readonly displayName: string;
    readonly description: string;

    // state is persisted as jsonb; move is parsed off the socket; config comes from the create
    // payload (falling back to defaultConfig). All three are validated with these schemas.
    readonly schema: {
        state: ZodType<State>;
        move: ZodType<Move>;
        config: ZodType<Config>;
    };
    readonly defaultConfig: Config;

    // Room created (host only, before any stake). Return the initial persisted state.
    createInitialState(ctx: CreateContext<Config>): State;

    // Both players have staked and the room flips to in_progress. Return the live starting state
    // (deal cards, open round 1, etc.).
    start(state: State, ctx: StartContext): State;

    validateMove(state: State, move: Move, ctx: MoveContext): ValidationResult;
    applyMove(state: State, move: Move, ctx: MoveContext): ApplyResult<State>;

    isComplete(state: State): boolean;
    outcome(state: State): Outcome;

    // Redacted, per-seat projection of the state for the wire. Hide opponents' hidden moves here.
    view(state: State, viewer: Seat): unknown;

    // Optional custom pot split. Omit to use the engine default above.
    settlement?(state: State, stakeWei: bigint): Settlement;
}

// Identity helper for ergonomic type inference when authoring a game.
export function defineGame<State, Move, Config>(
    module: GameModule<State, Move, Config>,
): GameModule<State, Move, Config> {
    return module;
}

// The registry stores modules type-erased. The engine validates all I/O against each module's
// zod schemas at the boundary, so the `any`s here never escape untyped into game code.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyGameModule = GameModule<any, any, any>;
