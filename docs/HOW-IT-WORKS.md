# How game-kit works

This is the deep-dive companion to the [README](../README.md). It explains what the template is made
of, how a request flows end to end, and — most importantly — **how you turn it into your game**: clone
it, play the demo, then tell an agent to *build game X* and let it strip the example down to the
primitives.

It documents the kit's wiring. For the **why** behind the platform flows it sits on — OAuth,
payments, presence — read the Metatron (TRON) platform docs, which are the canonical reference:

- **Guides (build-a-game order):** <https://metatron.gg/docs>
- **SDK reference:** <https://metatron.gg/sdk>
- **API reference / OpenAPI:** <https://metatron.gg/reference> · <https://metatron.gg/openapi.json>
- **Agents start here:** <https://metatron.gg/llms.txt> — a machine-readable index of all of the above.

---

## 1. The mental model: a seam

game-kit is built around one idea — a **seam** between *primitives you keep* and *a game you swap*.

```
┌──────────────────────── KEEP (the rails) ────────────────────────┐   ┌──── SWAP (your game) ────┐
│ packages/game-core   the GameModule interface + wire protocol     │   │ games/<id>/              │
│ apps/api/src/*       auth, payments, presence, the generic engine,│   │   schema.ts  (zod types) │
│                      the Redis socket hub                          │◀─▶│   module.ts  (pure logic)│
│ apps/web/src/core/*  auth, api client, socket hook, charge/store  │   │   screen.tsx (the UI)    │
│ deploy/              Caddy + Postgres + Redis + compose            │   └──────────────────────────┘
└───────────────────────────────────────────────────────────────────┘   registries point at it
```

Everything on the left is game-agnostic and you rarely touch it. Everything a *specific* game needs
lives in one `games/<id>/` folder plus two one-line registry entries. The generic engine drives any
game through the same lifecycle — **create → stake → start → moves → complete → settle** — without
knowing a single rule of that game.

The example game (`games/coinflip`) is deliberately throwaway. It exists to exercise every primitive
so you can see them working, then be deleted.

---

## 2. The pieces

| Path | What it is | Touch it? |
| --- | --- | --- |
| `packages/game-core` | The `GameModule<State, Move, Config>` interface + the client/server wire protocol (`RoomView`, `ServerMessage`, `ClientMessage`, `GameScreenProps`). Isomorphic, zod-only. | Rarely |
| `apps/api/src/game/engine.ts` | The **generic engine** — persists state, validates I/O against the module's schemas, serializes moves under a row lock, fans results out, fires settlement. | Almost never |
| `apps/api/src/game/registry.ts` | The list of games the API knows about. | Per game |
| `apps/api/src/payments/*` | The TRON charge / payout / pot adapter, the local intent mirror, the events socket, the poll backstop, and the store ([§6](#6-payments-two-shapes-of-money)). | Rarely |
| `apps/api/src/presence/*` | The game-half of TRON's mutually-attested play sessions ([§5](#5-presence-the-gate-for-silent-charges)). | Rarely |
| `apps/api/src/realtime/hub.ts` | Redis pub/sub fan-out so any stateless API replica can serve any socket. | Rarely |
| `apps/web/src/core/*` | Session auth, the API client, the room socket hook, the charge + store hooks, the presence widget. | Rarely |
| `apps/web/src/games/registry.tsx` | `gameId → React screen`. | Per game |
| `games/<id>/` | One game: `schema.ts` (zod state/move/config), `module.ts` (pure logic), `screen.tsx` (UI). | This is your game |

---

## 3. The GameModule contract

A game is a single pure object — no I/O, no globals, fully unit-testable:

```ts
interface GameModule<State, Move, Config> {
  id: string;
  displayName: string;
  description: string;
  schema: { state: ZodType<State>; move: ZodType<Move>; config: ZodType<Config> };
  defaultConfig: Config;

  createInitialState(ctx): State;            // host creates the room (pre-stake)
  start(state, ctx): State;                  // both players staked — deal/seed here, ctx.rng available
  validateMove(state, move, ctx): Result;    // is this move legal right now?
  applyMove(state, move, ctx): { state; events? };  // produce the next state (+ broadcast events)
  isComplete(state): boolean;
  outcome(state): { kind: "pending" | "win" | "draw"; winner? };
  view(state, seat): unknown;                // redacted per-seat projection (hide opponent secrets)
  settlement?(state, stakeWei): Settlement;  // OPTIONAL custom pot split

  // OPTIONAL realtime extension (mirrors the TRON hosted-game contract). Declare
  // `realtime: { tickRateHz? }` (capped 20Hz, default 10) and the engine drives a server tick
  // loop instead of waiting on moves: tick advances the world, input steers it silently, and
  // completion is decided after ticks. Turn-based modules omit all three and nothing changes.
  realtime?: { tickRateHz?: number };
  tick?(state, dtMs, ctx): { state; events? };      // advance the simulation by dtMs
  applyInput?(state, input, ctx): State;            // high-frequency input; throw to reject
}
```

Two rules carry most of the design:

1. **All randomness comes from the injected `ctx.rng`.** Never call `Math.random()` or `Date.now()`
   in game code. The engine injects a crypto RNG in production and lets tests inject a deterministic
   stub — so games are replayable and testable.
2. **Redaction lives in `view()`.** The persisted `state` holds everything; `view(state, seat)`
   returns only what *that* seat may see (your own hidden pick, but not the opponent's). The engine
   builds a fresh per-seat view for every socket, so secrets never reach the wrong browser.

Omit `settlement()` and the pot pays out automatically: winner takes 2× stake, a draw refunds each
player. Implement it only for custom splits. Settlement legs are always expressed in **wei**; on a
TRON-denominated room the engine scales them to ledger cents by the stake's ratio, so the same
`settlement()` works on either rail ([§6](#6-payments-two-shapes-of-money)).

Full interface walkthrough: [`packages/game-core/README.md`](../packages/game-core/README.md).

---

## 4. The request lifecycle

A room walks a small state machine (`RoomStatus`). Here is the whole path:

```
host creates room ─▶ awaiting_host_stake
       │  host charges stake (TRON)            ┌──────────── the generic engine ─────────────┐
       ▼                                      │ createRoom  → mint pot, createInitialState   │
   waiting ───────────────────────────────── │ charge      → record intent, gate on stakes  │
       │  guest joins + charges stake         │ start       → module.start(state, rng)       │
       ▼                                      │ applyMove   → validate → apply → persist      │
 awaiting_guest_stake ──▶ in_progress         │              (row-locked txn) → broadcast     │
       │  players submit moves over the WS    │ complete    → outcome() → settleRoom (pot)    │
       ▼                                      └───────────────────────────────────────────────┘
   completed  ──▶  settlement distributes the pot via TRON (fire-and-forget)
```

- **Create.** `POST /rooms` → `engine.createRoom` mints a fresh CreditVault **pot** (a `bytes16` id),
  calls `module.createInitialState`, and stores the room with status `awaiting_host_stake`.
- **Stake.** Each player charges into the pot ([§6](#6-payments-two-shapes-of-money)). When an intent
  completes, `advanceRoomAfterStakes` flips the room forward. Once both have paid, `module.start`
  runs with an RNG and the room goes `in_progress`.
- **Move.** The browser sends `{ type: "move" }` over the room WebSocket. `engine.applyMove` runs
  inside a `SELECT … FOR UPDATE` transaction so two moves — even arriving at different API replicas —
  serialize on the room row. It validates the move against the module's zod schema and
  `validateMove`, applies it, persists the new state, then broadcasts.
- **Complete & settle.** When `isComplete` is true, the engine derives the `outcome`, marks the room
  `completed`, broadcasts it, and *fire-and-forgets* `settleRoom`, which turns the outcome into pot
  legs and calls TRON `distributePot`. Settlement never blocks the live UI and is fail-soft.

The engine is the part you don't rewrite. Your game only supplies the pure `GameModule` methods it
calls.

---

## 5. Presence: the gate for silent charges

TRON play sessions are *mutually attested*: a browser widget (running in the player's first-party TRON
session, origin-isolated) and a **game half** on your server both heartbeat the same `playSessionId`.
A session reads `active` only while both halves are fresh.

In the kit:

- `apps/web/src/core/PresenceWidget.tsx` mounts TRON's widget and relays the minted `playSessionId`
  to the server over the room socket.
- `apps/api/src/presence/tron-presence.ts` drives the game half (`confirm` → `heartbeat` → `end`) with
  the app's own credentials.

Why it matters: an *active* session is the precondition for a **silent offline auto-charge** — TRON
will debit a present, under-cap player without a redirect. No presence, and the charge falls back to
the hosted confirm page. Presence is the same machinery for stakes and store purchases.

---

## 6. Payments: two shapes of money

The kit never holds funds. Money always flows through TRON. There are **two shapes**, and they share
all the same plumbing — the difference is one field.

### Shape A — pot stake (rooms)

Two players charge into a shared **pot**; the engine pays it back out on settle.

```
charge(amount, potId) ─▶ intent (pending) ─▶ TRON events socket / poll backstop ─▶ completed
                                                                  │
                                          both players completed ─┴─▶ room starts
room completes ─▶ settleRoom ─▶ distributePot(winner legs)  // winner-takes-pot / draw-refunds
```

#### Two rails: ETH and TRON

A pot stake runs on one of two rails, chosen at room creation (`rooms.currency`, picked in the lobby):

| Rail | Charge | Priced in | Settle | Notes |
|---|---|---|---|---|
| **`eth`** | `requestCharge` → `/oauth/payments/charge` | wei (`ethToWei`) | `requestDistribute` → on-chain `distributePot` | the on-chain CreditVault pot |
| **`tron`** | `tronClient.payments.tronCharge` | ledger cents (`tronToCents`, 1 TRON = 1¢) | `tronClient.payments.tronDistribute` | TRON's platform ledger — settles instantly, no chain/escrow; can return `insufficient_balance` (top-up + retry) |

Both rails share the identical intent machinery, the `completed`-vs-`redirect` consent flow, and the
`groupId`-bundled activity feed; only the denomination and the charge/distribute calls differ.
`settleRoom` computes leg shares once in wei (from `module.settlement()` or the default) and, on the
TRON rail, scales each leg to cents by the stake's cents:wei ratio — so a custom split is preserved
across either denomination. `payments/units.ts` holds `tronToCents`; `ethToWei` lives in
`game/settlement.ts`.

### Shape B — one-way purchase (the store)

A single charge with **no pot**. Nothing is escrowed and nothing is refunded; on completion the
server grants something in app state. This is the pattern for **selling in-game inventory or soft
currency**. The kit's demo grants **points** (`users.points`), shown in the top bar.

```
purchase(packId) ─▶ charge(amount)  [no potId]  ─▶ intent (kind: "purchase", pending)
                                                          │
                            completed (silent, or via TRON confirm + /payment-return)
                                                          │
                                       creditPurchaseIfCompleted ─▶ users.points += pack.points
```

### Why they share one code path

Both are TRON charge intents. The kit records every intent in one table
(`oauth_payment_intents`) with a `kind` discriminator, and **every** completion path — the
synchronous charge response, the TRON **events socket** (`payments/tron-socket.ts`), the 30-second
**poll backstop** (`payments/poll-backstop.ts`), and the `/payment-return` sync — funnels the
resolved intent through a single dispatcher:

```ts
// apps/api/src/game/engine.ts
export async function onIntentResolved(intent: IntentRow): Promise<void> {
  if (intent.status !== "completed") return;
  if (intent.kind === "purchase") return void creditPurchaseIfCompleted(intent.id); // grant points
  if (intent.roomId) {                                                              // advance the room
    const advanced = await advanceRoomAfterStakes(intent.roomId);
    if (advanced) await broadcastState(intent.roomId);
  }
}
```

`creditPurchaseIfCompleted` claims the row with a guarded `UPDATE` (`status = completed AND NOT
points_credited`) and only then increments the balance — so whichever path observes the completion
first credits exactly once, and the rest no-op. That idempotency is what lets the redirect path,
multi-replica sockets, and the poll backstop all run without double-granting.

**Where the purchase lives** (use it as the template for your own store item):

- `apps/api/src/payments/points.ts` — the pack catalog + the idempotent credit.
- `apps/api/src/payments/routes.ts` — `GET /payments/points`, `POST /payments/purchase`.
- `apps/web/src/routes/Store.tsx` + `core/use-charge.ts` (`usePurchase`) — the buy UI.

To sell a *cosmetic* or *consumable* instead of points, change what `creditPurchaseIfCompleted`
writes (a row in your own inventory table) — the money path is unchanged.

The full payments model (intent lifecycle, monthly caps, the hosted raise-limit screen, payouts, pot
distribution) is documented at <https://metatron.gg/docs/payments>.

---

## 7. Scaling & state

The API tier is **stateless**. All durable state is in Postgres; websocket fan-out goes through Redis
pub/sub (`realtime/hub.ts`). Any replica can serve any socket: when a move mutates a room, the engine
publishes a "room changed" signal to Redis, and every replica rebuilds the per-seat view for *its*
local sockets. Scale with `docker compose up -d --scale api=N` — no sticky sessions.

There is also **no per-game table**. A room's game state is a `jsonb` blob (`rooms.state`), validated
against the active module's schema on every read. Swapping games never migrates the database.

---

## 8. Building *your* game (the agent workflow)

This kit is designed to be finished by a coding agent. The intended flow:

1. **Clone and run the demo.** Get coinflip working locally (`pnpm install` → `pnpm setup` →
   `./scripts/dev.sh`) so the rails — sign-in, staking, real-time play, settlement, the store — are
   proven end to end on your machine.
2. **Tell your agent what to build.** Point it at [`AGENTS.md`](../AGENTS.md) (the repo's agent
   contract) and this file, then ask for your game in plain language. A good prompt:

   > Read AGENTS.md and docs/HOW-IT-WORKS.md. Build **<your game>**: `<one-paragraph rules — players,
   > turns, win condition, any hidden information, stake/payout shape>`. Replace the coinflip example —
   > add `games/<id>/` (schema, module, screen), register it in both registries, then delete
   > `games/coinflip` and its two registry entries. Keep the engine, payments, presence, and store
   > untouched. Take all randomness from the injected `rng`. Run `pnpm typecheck` and `pnpm build`.

3. **What the agent keeps vs. strips.** It writes one new `games/<id>/` folder and edits the two
   registries. It *deletes* coinflip. It does **not** touch the engine, the payment rails, presence,
   the socket hub, or the deploy stack — those are the primitives the whole point was to reuse.
4. **Verify.** `pnpm typecheck && pnpm build`, then `./scripts/dev.sh` and play it. Settlement and
   the store keep working for free because they're game-agnostic.

The mechanical version of step 2 is the five-step recipe in the [README](../README.md#build-your-own-game-5-steps)
and [`AGENTS.md`](../AGENTS.md). The point of the kit is that *building a game is mostly writing
`GameModule` methods* — everything around them already works.

---

## 9. Where to read more

- [`README.md`](../README.md) — quickstart, deploy, repo layout.
- [`AGENTS.md`](../AGENTS.md) — the agent contract (keep-vs-swap, the 5-step recipe, conventions).
- [`packages/game-core/README.md`](../packages/game-core/README.md) — the `GameModule` interface in full.
- [`games/coinflip/README.md`](../games/coinflip/README.md) — the example, annotated (delete it after).
- [`deploy/README.md`](../deploy/README.md) — the VPS runbook.
- **TRON platform docs** — <https://metatron.gg/docs> · SDK <https://metatron.gg/sdk> ·
  agents <https://metatron.gg/llms.txt>.
