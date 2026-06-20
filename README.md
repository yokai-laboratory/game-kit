# game-kit

A **full-stack web3 game template** built on the [Metatron](https://github.com/yokai-laboratory/metatron)
(TRON) identity + payment rails. Clone it, swap the example game for yours, and deploy to your own
Railway project (or a VPS with Docker Compose).

> **Platform docs:** the integration this kit demonstrates is documented in full at
> **[metatron.gg/docs](https://metatron.gg/docs)** (build-a-game guides),
> **[/sdk](https://metatron.gg/sdk)** (the typed SDK reference), and
> **[/reference](https://metatron.gg/reference)** (raw HTTP / OpenAPI). Building with an agent?
> Point it at **[metatron.gg/llms.txt](https://metatron.gg/llms.txt)** — a machine-readable
> index of all of the above, in build order.

It ships a working example — a **coin-flip duel** — that exercises every primitive (TRON sign-in,
staking into an on-chain pot, real-time play, winner-takes-pot settlement). The game logic is
designed to be **thrown away**; the primitives, infra, and onboarding are what you keep.

```
┌────────── browser ──────────┐        ┌───────────────── your VPS ─────────────────┐
│  React SPA (Vite)           │  https │  Caddy (auto-TLS)                            │
│  - TRON sign-in              │◀──────▶│   ├─ /        → web (nginx, static SPA)      │
│  - room socket              │   wss  │   ├─ /api/*   → api  (Hono, stateless, xN)   │
│  - TRON presence widget      │        │   └─ /ws/*    → api                          │
└─────────────────────────────┘        │  Postgres (state)   Redis (socket fan-out)  │
                                        └──────────────┬──────────────────────────────┘
                                                       │ server-to-server
                                                 Metatron API
                                          (OAuth, payments, pots, presence)
```

## Why this exists

Standing up a web3 game means re-solving the same plumbing every time: OAuth, wallet/payment
integration, presence-gated charges, pot settlement, real-time room sync, deploy. game-kit gives you
all of that as **reusable primitives** behind a clean seam, so building a new game is mostly writing
game rules.

## The seam: keep vs swap

| Keep (primitives) | Swap (your game) |
| --- | --- |
| `packages/game-core` — the `GameModule` interface + wire protocol | `games/<id>/` — one folder per game (logic + screen) |
| `apps/api` — auth, payments, presence, the **generic engine**, the realtime socket hub | `apps/api/src/game/registry.ts` — the list of games |
| `apps/web/src/core` — auth, API client, socket hook, charge/presence UI | `apps/web/src/games/registry.tsx` — gameId → screen |

A game is a `GameModule<State, Move, Config>` (pure, isomorphic logic) plus a React screen. The
generic engine drives any module through the lifecycle — **create → stake → start → moves → complete
→ settle** — without knowing the rules.

> **New here? Read [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md)** — the architecture, the request
> lifecycle, the two payment shapes, and the "tell an agent to build my game" workflow, end to end.

## Quickstart (local)

Prereqs: Node 24, pnpm 11, and a reachable **Postgres** — game-kit persists to Postgres, and
`dev.sh` runs the api+web but does **not** start a database (bring your own). The realtime hub fans
out in-process by default, so **Redis is optional** (see [Scaling](#scaling)). You also need a
Metatron app provisioned — `pnpm setup` does that through Metatron's developer surface (see
[Provisioning](#provisioning-via-metatron)).

```bash
pnpm install
# bring up a Postgres matching DATABASE_URL's default (postgres://postgres:postgres@localhost:5432/game_kit):
docker run -d --name game-kit-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=game_kit -p 5432:5432 postgres:16
pnpm setup            # provision your Metatron app + write env files (or see the setup skill)
./scripts/dev.sh      # api + web with hot reload (against Postgres + Metatron; schema auto-bootstraps)
# open http://localhost:5274
```

### Provisioning via Metatron

game-kit is an **external consumer** of Metatron — it has no Metatron source or database access.
Everything it needs (an OAuth app, a client key, redirect URIs, and a **payout address** for the chain
it charges on) is requested through Metatron's **developer surface**: the Metatron MCP, the developer
dashboard, or the developer REST API under `/me/developer/*`. `pnpm setup` automates this when given a
developer token, or walks you through the dashboard otherwise. `payments:charge` is only granted once
the app has a payout address for `PAYMENT_CHAIN`, so set one during provisioning or sign-in will fail
with `invalid_scope`.

## Build your own game (5 steps)

1. `cp -r games/coinflip games/<your-id>`; rename the package to `@game-kit/game-<your-id>`.
2. Rewrite `schema.ts` (zod state/move/config) and `module.ts` (implement the `GameModule`). Take all
   randomness from the injected `rng`.
3. Rewrite `screen.tsx` (a `GameScreenProps<YourView, YourMove>` component).
4. Register: add the module to `apps/api/src/game/registry.ts` and the screen to
   `apps/web/src/games/registry.tsx`, and add the package as a dependency of `apps/api` + `apps/web`.
5. `pnpm install && pnpm typecheck`, then `./scripts/dev.sh`.

Then delete `games/coinflip` and its two registry entries. See
[packages/game-core/README.md](packages/game-core/README.md) for the full interface walkthrough.

## Deploy

Both paths deploy **web + api + Postgres + Redis** into infra **you own and pay for** — Metatron never
hosts it. Full runbook: [deploy/README.md](deploy/README.md) and the **deploy skill** (`skills/deploy`).

**Railway (managed, default).** [`deploy/railway/`](deploy/railway/README.md) is config-as-code for
your own Railway workspace. The Metatron MCP `provision_stack` tool (metatron#349) instantiates it and
auto-wires `DATABASE_URL` / `REDIS_URL` (Railway plugins) plus the `OAUTH_*` / `TRON_*` / `PAYMENT_*`
values from your Metatron developer app. Railway terminates TLS, so there is no Caddy.

**VPS / docker-compose (BYOC).** One ~8GB/4vCPU box (the base stack fits in ~1.5GB):

```bash
bash scripts/preflight-vps.sh          # checks docker, ports, RAM/disk
cp deploy/.env.example deploy/.env      # or: pnpm setup  (fill DOMAIN, TRON keys, secrets)
cd deploy && docker compose --env-file .env up -d --build
# verify: curl -fsS https://<domain>/api/ready
```

Caddy auto-provisions TLS once `DOMAIN` resolves to the box.

### Scaling

By default the API runs **single-replica**: state lives in **Postgres** and the realtime socket hub +
tick lease fan out **in-process** — no Redis required. That's the right shape for one box.

To scale horizontally, one seam flips on when you set **`REDIS_URL`**: the realtime hub switches to a
Redis pub/sub backplane and the tick loop to a Redis lease (`apps/api/src/realtime/hub.ts`,
`apps/api/src/game/ticker.ts` — `ioredis` is lazy-loaded, so the single-replica path never imports
it). Postgres is already the shared store (moves serialize on a row-locked `SELECT … FOR UPDATE`), so
any replica can serve any socket behind a load balancer. The in-process and Redis impls sit behind the
same interfaces, so this is a config change, not a rewrite.

## Repo layout

```
apps/
  api/           Hono API: auth, payments, presence, generic engine, realtime socket hub (Postgres; Redis optional)
  web/           Vite + React SPA: lobby, room, charge/presence UI, game registry
packages/
  game-core/     The GameModule interface + client/server wire protocol (isomorphic, zod-only)
  smart-contracts/  OPTIONAL Foundry scaffold for custom on-chain logic (TRON handles payments)
games/
  coinflip/      The example game (scrap me): schema + module (logic) + screen (UI)
deploy/          railway/ (managed config-as-code) + docker-compose/Caddyfile (BYOC), env example
scripts/         setup.ts (TRON keys), dev.sh, preflight-vps.sh
skills/          agent runbooks: setup, deploy
docs/            HOW-IT-WORKS.md — architecture deep-dive + the build-a-game agent workflow
AGENTS.md        the agent-first contract for this repo
```

The web app also ships a **store** (`apps/web/src/routes/Store.tsx`) demonstrating one-way purchases —
buy point packs with a TRON charge; balance shows in the top bar. Keep it as a reference for selling
in-game inventory, or delete it alongside coinflip if your game doesn't need a store.

## SDK

`@metatrongg/sdk` is published to the **public npm registry**, so a plain `pnpm install` resolves it —
no Verdaccio, no scope pin, and Docker builds need no host networking for it.

> **Keep the SDK current with tron.** The pinned `@metatrongg/sdk` version drifts behind whenever
> metatron publishes a new SDK release — so **whenever the tron SDK is updated, bump it here too**.
> Update the `@metatrongg/sdk` specifier in `apps/api/package.json` + `apps/web/package.json` to the
> new version, re-run `pnpm install`, and commit the lockfile. A stale pin surfaces at runtime, most
> painfully on a breaking rename (e.g. tron's `tusd`→`tron` turned `payments.tusdCharge` into
> `payments.tronCharge` → `TypeError: ... is not a function`). The sibling games (high-low,
> coin-factory) follow the same rule.

## How payments work (at a glance)

This repo never holds funds. Money always flows through TRON, in **two shapes** that share all the same
plumbing (intent mirror, events socket, poll backstop):

- **Pot stake (rooms).** A room mints a CreditVault **pot**; each player stakes into it via TRON
  `charge` (silent if the player's browser is present + offline-charge is enabled, otherwise a TRON
  confirm redirect). On completion the engine derives a settlement from the module's `outcome()` and
  calls TRON `distributePot` — winner-takes-pot by default, split-refund on a draw. Fail-soft.
- **One-way purchase (the store).** A single `charge` with **no pot** — nothing is escrowed or
  refunded. On completion the server grants something in app state; the demo credits **points**
  (`users.points`, shown in the top bar). This is the pattern for selling in-game currency or
  inventory — see [`apps/api/src/payments/points.ts`](apps/api/src/payments/points.ts),
  `POST /payments/purchase`, and [`apps/web/src/routes/Store.tsx`](apps/web/src/routes/Store.tsx).
  Both shapes funnel completions through one idempotent dispatcher (`onIntentResolved`).

The optional `packages/smart-contracts` scaffold is for games that need their **own** on-chain logic
beyond TRON's pots — not the money path. Full walkthrough: [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md).

## License

Add your license here.
