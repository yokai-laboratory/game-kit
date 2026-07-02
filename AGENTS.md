# AGENTS.md — working in game-kit

This repo is a **full-stack web3 game template** built on the Metatron (TRON) rails. It ships a
throwaway example game (coin-flip duel). Your job as an agent is usually one of: **(a) build a new
game** by replacing the example, **(b) set up TRON keys**, or **(c) deploy to a VPS**. This file is
the contract for doing that without breaking the reusable parts.

## Platform documentation (TRON)

This kit is a worked example of the Metatron platform flows — auth, payments, presence. When you
need the **why** behind the integration (not just the kit's wiring), read the platform docs. They are
built to be read by agents:

- **Agents start here:** [`https://metatron.gg/llms.txt`](https://metatron.gg/llms.txt) — a
  machine-readable index of every guide, the SDK reference, the OpenAPI document, and this starter, in
  build order. Fetch it first to orient.
- **Developer guides** (conceptual, build-a-game order): `https://metatron.gg/docs` — register an
  app → authentication → payments → webhooks/realtime → presence → ship.
- **SDK reference** (the typed functions this kit calls): `https://metatron.gg/sdk`.
- **API reference / raw HTTP:** `https://metatron.gg/reference` (interactive) and
  `https://metatron.gg/openapi.json` (the document the SDK is generated from).

Rule of thumb: the SDK is the integration surface (this kit uses it); reach for raw HTTP / OpenAPI only
for something the SDK doesn't cover.

**Kit internals.** Before changing anything, read [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) — the
architecture, the request lifecycle, the two payment shapes (pot stake vs. one-way purchase), and the
build-a-game workflow. It's the map for everything below. For the web UI, read
[`docs/SHELL.md`](docs/SHELL.md): the game-centred shell (fullscreen game surface, capsule nav,
three-column pages, the tap-to-start play stage) and the engine-adapter contract — Unity, Godot,
GameMaker, or a plain canvas all plug in the same way, and the shell itself carries no engine code.
Brand the chrome in `apps/web/src/shell.config.tsx`; keep `core/shell/*` and `core/ui/*`.

## The one big idea: the seam

Everything splits into **primitives you keep** and **a game you swap**.

| Keep (primitives — rarely edit) | Swap (the game) |
| --- | --- |
| `packages/game-core` — the `GameModule` interface + wire protocol | `games/<id>/` — one folder per game |
| `apps/api/src/*` except the registry — auth, payments, presence, the Redis socket hub, the generic engine | `apps/api/src/game/registry.ts` — lists which games exist |
| `apps/web/src/core/*` — auth, api client, socket hook, charge/presence | `apps/web/src/games/registry.tsx` — maps gameId → screen |

A game is a `GameModule<State, Move, Config>` (pure logic) + a React screen. The generic engine in
`apps/api/src/game/engine.ts` drives any module through the lifecycle: create → stake → start →
moves → complete → settle. **You almost never edit the engine, payments, auth, or presence.**

## Build a new game in 5 steps

1. `cp -r games/coinflip games/<your-id>` and rename the package in its `package.json`
   (`@game-kit/game-<your-id>`).
2. Rewrite `schema.ts` (zod `state` / `move` / `config`) and `module.ts` (implement the `GameModule`
   methods: `createInitialState`, `start`, `validateMove`, `applyMove`, `isComplete`, `outcome`,
   `view`). Take ALL randomness from the injected `rng`; never call `Math.random()`/`Date.now()` in
   game code. Default pot settlement (winner-takes-pot / draw-refunds) is automatic — only add
   `settlement()` for custom splits. For a real-time game, also declare `realtime: { tickRateHz }`
   and implement `tick(state, dtMs, ctx)` + `applyInput(state, input, ctx)` — the engine then runs
   a server tick loop instead of waiting on moves (see `docs/HOW-IT-WORKS.md`).
3. Rewrite `screen.tsx` (a `GameScreenProps<YourView, YourMove>` component).
4. Register it: add the module to `MODULES` in `apps/api/src/game/registry.ts`, the screen to
   `SCREENS` in `apps/web/src/games/registry.tsx`, and the package as a dependency of both
   `apps/api` and `apps/web`.
5. `pnpm install && pnpm typecheck`, then `./scripts/dev.sh` and play it.

Delete `games/coinflip` (and its two registry entries) once your game works.

## Commands

- `pnpm install` — installs from public npm; `@metatrongg/sdk` is published there, no special registry.
- `pnpm typecheck` / `pnpm lint` / `pnpm build` — across the workspace (turbo).
- `./scripts/dev.sh` — api + web with hot reload against the Postgres at `DATABASE_URL` and your
  Metatron app. **Provide the Postgres yourself** (a local `postgres:16` container, or any reachable
  instance) — `dev.sh` does not start one. The schema auto-bootstraps on first boot
  (`CREATE TABLE IF NOT EXISTS` in `apps/api/src/db/client.ts`); there is no migrate step or command.
  Redis is optional — set `REDIS_URL` only to scale past a single api replica.
- `pnpm setup` — provision your Metatron OAuth app + write env files (see the setup skill). It reaches
  Metatron **only through Metatron's developer surface** (the MCP / developer dashboard / developer
  REST API under `/me/developer/*`) — game-kit is an external consumer of Metatron, never a peer with
  source or DB access. Anything it needs from Metatron (an app, a client key, redirect URIs, a payout
  address) is requested through that surface.

The SDK (`@metatrongg/sdk`) is published to the **public npm registry**, so a plain `pnpm install`
resolves it — no Verdaccio, no scope pin, and Docker builds need no host networking for it.

## Architecture notes (so you don't fight the design)

- **State is generic.** There is no per-game DB table. A room's game state is a `jsonb` blob in
  `rooms.state`, validated against the module's schema on every read. Swapping games never migrates
  the DB.
- **Horizontal scaling.** The API is stateless: state in Postgres, websocket fan-out via Redis
  pub/sub (`apps/api/src/realtime/hub.ts`). Any replica serves any socket. Scale with
  `docker compose up --scale api=N`; no sticky sessions.
- **Money is TRON's.** Stakes/pots/payouts go through the TRON SDK (`charge`, `distributePot`,
  presence). This repo never holds funds. `packages/smart-contracts` is an *optional* scaffold for
  custom on-chain logic, not the payment path.
- **Two payment shapes, one path.** A *pot stake* (rooms) escrows money and pays it back on settle; a
  *one-way purchase* (the store — `payments/points.ts`, `POST /payments/purchase`) charges with no pot
  and grants app state (the demo credits `users.points`). Both record an `oauth_payment_intent` and
  funnel completion through `onIntentResolved` in `game/engine.ts`. To sell in-game inventory, copy
  the purchase flow and change what `creditPurchaseIfCompleted` writes — don't invent a new money
  path. Crediting is idempotent (a guarded `UPDATE`); keep it that way (the events socket, poll
  backstop, and return-page sync can all observe the same completion).
- **Two stake rails (`rooms.currency`).** A pot stake runs on either `eth` (priced in wei, on-chain
  `distributePot`) or `tron` (priced in ledger cents via `payments/units.ts`, instant
  `tronDistribute`), chosen in the lobby. They share all the intent plumbing — only the charge/distribute
  calls and denomination differ. See `docs/HOW-IT-WORKS.md` §6.
- **Concurrency.** Moves apply inside a row-locked transaction (`SELECT … FOR UPDATE`) so two moves
  serialize on the room row even across replicas.

## Conventions

- TypeScript strict, ESM, 4-space indent, `verbatimModuleSyntax`. Match the surrounding style.
- API runs via `tsx` (no compile in prod); the web is a Vite static build.
- Don't commit `.env` / `deploy/.env` (gitignored). `pnpm setup` writes them.

## Deploy

Two paths, both deploying **web + api + Postgres + Redis** into infra **you own and pay for** —
Metatron never hosts it. See the deploy skill and `deploy/README.md`.

- **Railway (managed, default).** `deploy/railway/` is config-as-code for the creator's own Railway
  workspace; the Metatron MCP `provision_stack` tool (metatron#349) instantiates it and auto-wires
  `DATABASE_URL`/`REDIS_URL` (Railway plugins) + the `OAUTH_*`/`TRON_*`/`PAYMENT_*` values from your
  Metatron developer app. Railway terminates TLS, so there is no Caddy.
- **VPS / docker-compose (BYOC).** `scripts/preflight-vps.sh` → `cp deploy/.env.example deploy/.env`
  (or `pnpm setup`) → `cd deploy && docker compose --env-file .env up -d --build` → check
  `https://<domain>` and `/ready`. Caddy auto-provisions TLS here.
