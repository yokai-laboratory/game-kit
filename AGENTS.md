# AGENTS.md — working in game-kit

This repo is a **full-stack web3 game template** built on the Titanium Games (TTG) rails. It ships a
throwaway example game (coin-flip duel). Your job as an agent is usually one of: **(a) build a new
game** by replacing the example, **(b) set up TTG keys**, or **(c) deploy to a VPS**. This file is
the contract for doing that without breaking the reusable parts.

## Platform documentation (TTG)

This kit is a worked example of the Titanium Games platform flows — auth, payments, presence. When you
need the **why** behind the integration (not just the kit's wiring), read the platform docs. They are
built to be read by agents:

- **Agents start here:** [`https://titaniumgames.gg/llms.txt`](https://titaniumgames.gg/llms.txt) — a
  machine-readable index of every guide, the SDK reference, the OpenAPI document, and this starter, in
  build order. Fetch it first to orient.
- **Developer guides** (conceptual, build-a-game order): `https://titaniumgames.gg/docs` — register an
  app → authentication → payments → webhooks/realtime → presence → ship.
- **SDK reference** (the typed functions this kit calls): `https://titaniumgames.gg/sdk`.
- **API reference / raw HTTP:** `https://titaniumgames.gg/reference` (interactive) and
  `https://titaniumgames.gg/openapi.json` (the document the SDK is generated from).

Rule of thumb: the SDK is the integration surface (this kit uses it); reach for raw HTTP / OpenAPI only
for something the SDK doesn't cover.

**Kit internals.** Before changing anything, read [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) — the
architecture, the request lifecycle, the two payment shapes (pot stake vs. one-way purchase), and the
build-a-game workflow. It's the map for everything below.

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
   `settlement()` for custom splits.
3. Rewrite `screen.tsx` (a `GameScreenProps<YourView, YourMove>` component).
4. Register it: add the module to `MODULES` in `apps/api/src/game/registry.ts`, the screen to
   `SCREENS` in `apps/web/src/games/registry.tsx`, and the package as a dependency of both
   `apps/api` and `apps/web`.
5. `pnpm install && pnpm typecheck`, then `./scripts/dev.sh` and play it.

Delete `games/coinflip` (and its two registry entries) once your game works.

## Commands

- `pnpm install` — **requires the `@titanium-games/sdk` registry** (see below).
- `pnpm typecheck` / `pnpm lint` / `pnpm build` — across the workspace (turbo).
- `./scripts/dev.sh` — Postgres+Redis in Docker, migrate, then api+web with hot reload.
- `pnpm setup` — wire TTG OAuth keys + write env files (see the setup skill).
- `pnpm db:migrate` — idempotent schema bootstrap.

## Install prerequisite (read this before `pnpm install`)

`@titanium-games/sdk` is **not on public npm** — `.npmrc` points the `@titanium-games` scope at a
local Verdaccio (`http://localhost:4873`) that the titanium-games repo runs. Before installing:

```
# in the titanium-games repo:
docker compose up -d verdaccio
pnpm build --filter @titanium-games/sdk
cd packages/sdk && pnpm publish --registry http://localhost:4873 --no-git-checks
```

If you host the SDK elsewhere, repoint the scope in `.npmrc`. Docker builds reach it via host
networking (`network: host` on the build) — keep Verdaccio reachable during `docker compose build`.

## Architecture notes (so you don't fight the design)

- **State is generic.** There is no per-game DB table. A room's game state is a `jsonb` blob in
  `rooms.state`, validated against the module's schema on every read. Swapping games never migrates
  the DB.
- **Horizontal scaling.** The API is stateless: state in Postgres, websocket fan-out via Redis
  pub/sub (`apps/api/src/realtime/hub.ts`). Any replica serves any socket. Scale with
  `docker compose up --scale api=N`; no sticky sessions.
- **Money is TTG's.** Stakes/pots/payouts go through the TTG SDK (`charge`, `distributePot`,
  presence). This repo never holds funds. `packages/smart-contracts` is an *optional* scaffold for
  custom on-chain logic, not the payment path.
- **Two payment shapes, one path.** A *pot stake* (rooms) escrows money and pays it back on settle; a
  *one-way purchase* (the store — `payments/points.ts`, `POST /payments/purchase`) charges with no pot
  and grants app state (the demo credits `users.points`). Both record an `oauth_payment_intent` and
  funnel completion through `onIntentResolved` in `game/engine.ts`. To sell in-game inventory, copy
  the purchase flow and change what `creditPurchaseIfCompleted` writes — don't invent a new money
  path. Crediting is idempotent (a guarded `UPDATE`); keep it that way (the events socket, poll
  backstop, and return-page sync can all observe the same completion).
- **Concurrency.** Moves apply inside a row-locked transaction (`SELECT … FOR UPDATE`) so two moves
  serialize on the room row even across replicas.

## Conventions

- TypeScript strict, ESM, 4-space indent, `verbatimModuleSyntax`. Match the surrounding style.
- API runs via `tsx` (no compile in prod); the web is a Vite static build.
- Don't commit `.env` / `deploy/.env` (gitignored). `pnpm setup` writes them.

## Deploy

See the deploy skill and `deploy/README.md`. TL;DR on the VPS: `scripts/preflight-vps.sh` →
`cp deploy/.env.example deploy/.env` (or `pnpm setup`) → `cd deploy && docker compose --env-file .env
up -d --build` → check `https://<domain>` and `/ready`.
