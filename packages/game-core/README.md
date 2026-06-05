# @game-kit/game-core

The isomorphic core every game-kit game is built on. Two things live here:

1. **`GameModule<State, Move, Config>`** — the interface your game implements.
2. **The wire protocol** — the room/socket types shared by `apps/api` and `apps/web`.

It depends on nothing but `zod` (no node, no react), so the same code runs on the server, in the
browser, and in tests.

## The lifecycle the engine drives

The generic engine in `apps/api` owns persistence, concurrency, payments, presence, and socket
fan-out. It calls your module's pure methods at each step:

```
createRoom  ─▶ createInitialState(host, config)          // host only, pre-stake
both staked ─▶ start(state, {host, guest, rng})           // match begins
a move      ─▶ validateMove(state, move, {by, rng})       // reject? -> error to that socket
            └▶ applyMove(state, move, {by, rng}) -> {state, events?}
after apply ─▶ isComplete(state) ? outcome(state) : keep going
on complete ─▶ (engine) settle the pot from outcome()  (or your settlement() override)
every push  ─▶ view(state, seat)  // redacted per-seat snapshot sent over the socket
```

## Implementing a game

```ts
import { defineGame } from "@game-kit/game-core";
import { z } from "zod";

const state = z.object({ /* … */ });
const move = z.object({ /* … */ });
const config = z.object({ rounds: z.number().int().default(3) });

export const myGame = defineGame({
    id: "my-game",
    displayName: "My Game",
    description: "…",
    schema: { state, move, config },
    defaultConfig: { rounds: 3 },

    createInitialState({ host, config }) { /* return initial State */ },
    start(state) { /* both staked; return live starting State */ return state; },
    validateMove(state, move, ctx) { return { ok: true }; /* or { ok:false, code } */ },
    applyMove(state, move, ctx) { /* return { state: next, events?: [...] } */ },
    isComplete(state) { /* boolean */ },
    outcome(state) { /* {kind:"pending"} | {kind:"win", winner} | {kind:"draw"} */ },
    view(state, viewer) { /* redacted per-seat projection */ },
    // settlement?(state, stakeWei) {}   // optional; omit for winner-takes-pot / draw-refund
});
```

### Rules of the road

- **Determinism.** Take all randomness from the injected `rng` (`int`, `bool`, `pick`). Never call
  `Math.random()` or `Date.now()` in game code — that keeps games replayable and unit-testable
  (inject a stub `rng`), and lets you later swap in provably-fair/on-chain randomness in one place.
- **Redaction lives in `view()`.** The full `State` is persisted server-side and never sent raw.
  `view(state, seat)` returns what that seat is allowed to see (hide the opponent's pending move).
- **`events` are public.** They're broadcast verbatim to both players (use for reveal/animation
  cues). Anything seat-specific belongs in `view()`.
- **Settlement is automatic.** The engine pays the pot from `outcome()`: winner gets `2 × stake`, a
  draw refunds `1 × stake` each. Implement `settlement(state, stakeWei)` only for custom splits
  (rake, multiway, partial refunds).

## The wire protocol (the screen side)

A screen receives `GameScreenProps<View, Move>`:

```ts
interface GameScreenProps<View, Move> {
    view: View;                 // your view() output for this seat
    seat: "host" | "guest";
    you: PublicUser;
    opponent: PublicUser | null;
    status: RoomStatus;         // awaiting_*_stake | waiting | in_progress | completed
    result: RoomResult;         // pending | win | draw
    submitMove: (move: Move) => void;
    lastEvent: GameEvent | null; // most recent broadcast event
}
```

See `games/coinflip` for a complete, minimal reference implementation.
