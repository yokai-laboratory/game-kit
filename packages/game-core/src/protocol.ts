// The client/server wire protocol. Both apps/api and apps/web import these types so the socket
// + REST contract stays in lockstep. Nothing here is game-specific: the game-defined payloads
// (state, events, moves) ride inside `unknown` fields whose shape the GameModule owns.

export type Seat = "host" | "guest";

// Mirrors the room state machine in apps/api. `awaiting_*_stake` map onto the TRON payment-intent
// lifecycle: the room sits there until TRON fires `intent.completed` (or the poll backstop catches
// up). `cancelled` is reserved for an explicit cancel surface.
export type RoomStatus =
    | "awaiting_host_stake"
    | "waiting"
    | "awaiting_guest_stake"
    | "in_progress"
    | "completed"
    | "cancelled";

export type RoomResult =
    | { kind: "pending" }
    | { kind: "win"; winnerUserId: string }
    | { kind: "draw" };

export interface PublicUser {
    id: string;
    displayName: string;
}

// Generic, game-agnostic room metadata. The game's own state is NOT here -- it travels in
// `RoomView.game.state` so the core never has to know a game's shape.
export interface RoomMeta {
    id: string;
    gameId: string;
    hostUserId: string;
    hostDisplayName: string;
    guestUserId: string | null;
    guestDisplayName: string | null;
    stakeEth: string;
    status: RoomStatus;
    result: RoomResult;
    createdAt: number;
}

// The per-client view pushed over the socket. `game.state` is the GameModule's redacted,
// per-seat view (its screen casts it back to the game's own type via the game's schema).
export interface RoomView {
    room: RoomMeta;
    you: PublicUser;
    opponent: PublicUser | null;
    seat: Seat;
    game: { id: string; state: unknown };
}

// A game-defined broadcast payload (e.g. a coin-flip reveal). Same payload for every participant;
// opaque to the core. `kind` lets a screen switch on event types.
export interface GameEvent {
    kind: string;
    [key: string]: unknown;
}

export type ClientMessage =
    // A game move. `move` is validated server-side against the GameModule's move schema.
    | { type: "move"; move: unknown }
    // Realtime games only: a high-frequency input (validated against the module's input schema
    // when one is declared). Applied silently; state arrives with the next server tick.
    | { type: "input"; input: unknown }
    // Active-play presence (TRON): the browser presence widget mints the user-half play session and
    // relays its id here so the server can drive the GAME half. The server never mints the user half.
    | { type: "presence"; playSessionId: string };

export type ServerMessage =
    | { type: "state"; view: RoomView }
    | { type: "event"; event: GameEvent }
    | { type: "completed"; result: RoomResult }
    // Server-derived presence: true only while BOTH halves are fresh -- the precondition TRON's
    // silent offline-charge gate consults. The room defers an offline-eligible stake charge until
    // this is true so it isn't fired into a guaranteed redirect.
    | { type: "presence_state"; active: boolean }
    | { type: "error"; message: string };

export interface GameHistoryItem {
    id: string;
    gameId: string;
    stakeEth: string;
    role: Seat;
    opponent: PublicUser | null;
    outcome: "win" | "loss" | "draw";
    finishedAt: number;
    createdAt: number;
}

// The props every game screen receives from the generic Room component on the web side. Kept
// React-free here so game-core stays isomorphic; a game's screen is just
// `(props: GameScreenProps<MyView, MyMove>) => JSX.Element`. `view` is the GameModule.view()
// output for this seat; `submitMove` sends a move over the socket (validated server-side).
export interface GameScreenProps<View, Move, Input = unknown> {
    view: View;
    seat: Seat;
    you: PublicUser;
    opponent: PublicUser | null;
    status: RoomStatus;
    result: RoomResult;
    submitMove: (move: Move) => void;
    // Realtime games: send a high-frequency input. No-op for turn-based games (the server rejects
    // inputs on modules without a realtime declaration).
    submitInput: (input: Input) => void;
    // Most recent game event broadcast to the room (e.g. a reveal). Null until one arrives.
    lastEvent: GameEvent | null;
}
