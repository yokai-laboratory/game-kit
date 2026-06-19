# game-kit

A **full-stack web3 game template** built on the [Titanium Games](https://github.com/yokai-laboratory/titanium-games)
(TTG) identity + payment rails. Clone it, swap the example game for yours, and deploy to a small VPS
with Docker Compose.

> **Platform docs:** the integration this kit demonstrates is documented in full at
> **[titaniumgames.gg/docs](https://titaniumgames.gg/docs)** (build-a-game guides),
> **[/sdk](https://titaniumgames.gg/sdk)** (the typed SDK reference), and
> **[/reference](https://titaniumgames.gg/reference)** (raw HTTP / OpenAPI). Building with an agent?
> Point it at **[titaniumgames.gg/llms.txt](https://titaniumgames.gg/llms.txt)** — a machine-readable
> index of all of the above, in build order.

It ships a working example — a **coin-flip duel** — that exercises every primitive (TTG sign-in,
staking into an on-chain pot, real-time play, winner-takes-pot settlement). The game logic is
designed to be **thrown away**; the primitives, infra, and onboarding are what you keep.

```
┌────────── browser ──────────┐        ┌───────────────── your VPS ─────────────────┐
│  React SPA (Vite)           │  https │  Caddy (auto-TLS)                            │
│  - TTG sign-in              │◀──────▶│   ├─ /        → web (nginx, static SPA)      │
│  - room socket              │   wss  │   ├─ /api/*   → api  (Hono, stateless, xN)   │
│  - TTG presence widget      │        │   └─ /ws/*    → api                          │
└─────────────────────────────┘        │  Postgres (state)   Redis (socket fan-out)  │
                                        └──────────────┬──────────────────────────────┘
                                                       │ server-to-server
                                                 Titanium Games API
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

Prereqs: Node 24, pnpm 11. No Docker needed locally — state is a single SQLite file and the
realtime hub fans out in-process (see [Scaling](#scaling)). **And** the `@titanium-games/sdk`
registry — see [SDK prerequisite](#sdk-prerequisite).

```bash
pnpm install
pnpm setup            # wire TTG OAuth keys + write env files (or see the setup skill)
./scripts/dev.sh      # api + web with hot reload (SQLite on disk; no containers)
# open http://localhost:5274
```

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

## Deploy to a VPS

Target: one ~8GB/4vCPU box; the base stack fits in ~1.5GB. On the server:

```bash
bash scripts/preflight-vps.sh          # checks docker, ports, RAM/disk
cp deploy/.env.example deploy/.env      # or: pnpm setup  (fill DOMAIN, TTG keys, secrets)
cd deploy && docker compose --env-file .env up -d --build
# verify: curl -fsS https://<domain>/api/ready
```

Caddy auto-provisions TLS once `DOMAIN` resolves to the box. Full runbook:
[deploy/README.md](deploy/README.md) and the **deploy skill** (`skills/deploy`).

### Scaling

By default the API runs **single-machine, dependency-free**: state is a local SQLite file and the
realtime socket hub + tick lease fan out **in-process** — no Postgres, no Redis. That's the right
shape for one box and keeps local dev zero-infra.

To scale horizontally, two seams flip on when you set **`REDIS_URL`**: the realtime hub switches to a
Redis pub/sub backplane and the tick loop to a Redis lease (`apps/api/src/realtime/hub.ts`,
`apps/api/src/game/ticker.ts` — `ioredis` is lazy-loaded, so the single-node path never touches it).
Pair that with a shared database (point persistence at a networked DB instead of the local SQLite
file) and any replica can serve any socket behind a load balancer. The in-memory and Redis impls sit
behind the same interfaces, so this is a config change, not a rewrite.

## Repo layout

```
apps/
  api/           Hono API: auth, payments, presence, generic engine, realtime socket hub (SQLite; Redis optional)
  web/           Vite + React SPA: lobby, room, charge/presence UI, game registry
packages/
  game-core/     The GameModule interface + client/server wire protocol (isomorphic, zod-only)
  smart-contracts/  OPTIONAL Foundry scaffold for custom on-chain logic (TTG handles payments)
games/
  coinflip/      The example game (scrap me): schema + module (logic) + screen (UI)
deploy/          docker-compose (+ observability/anvil/dev overlays), Caddyfile, env example
scripts/         setup.ts (TTG keys), dev.sh, preflight-vps.sh
skills/          agent runbooks: setup, deploy
docs/            HOW-IT-WORKS.md — architecture deep-dive + the build-a-game agent workflow
AGENTS.md        the agent-first contract for this repo
```

The web app also ships a **store** (`apps/web/src/routes/Store.tsx`) demonstrating one-way purchases —
buy point packs with a TTG charge; balance shows in the top bar. Keep it as a reference for selling
in-game inventory, or delete it alongside coinflip if your game doesn't need a store.

## SDK prerequisite

`@titanium-games/sdk` is **not on public npm**. `.npmrc` points the `@titanium-games` scope at a
local Verdaccio (`http://localhost:4873`) that the titanium-games repo runs:

```bash
# in the titanium-games repo:
docker compose up -d verdaccio
pnpm build --filter @titanium-games/sdk
cd packages/sdk && pnpm publish --registry http://localhost:4873 --no-git-checks
```

Hosting the SDK elsewhere? Repoint the scope in `.npmrc`. Docker builds reach the registry via host
networking; keep it up during `docker compose build`.

> **Keep the SDK current with ttg.** The pinned `@titanium-games/sdk` version drifts behind whenever
> titanium-games rebuilds + republishes the SDK to Verdaccio — so **whenever the ttg SDK is updated,
> bump it here too**. Update the `@titanium-games/sdk` specifier in `apps/api/package.json` +
> `apps/web/package.json` to the new version, re-run `pnpm install`, and commit the lockfile. A stale
> pin surfaces at runtime, most painfully on a breaking rename (e.g. ttg's `tusd`→`tix` turned
> `payments.tusdCharge` into `payments.tixCharge` → `TypeError: ... is not a function`). The sibling
> games (high-low, coin-factory) follow the same rule.

## How payments work (at a glance)

This repo never holds funds. Money always flows through TTG, in **two shapes** that share all the same
plumbing (intent mirror, events socket, poll backstop):

- **Pot stake (rooms).** A room mints a CreditVault **pot**; each player stakes into it via TTG
  `charge` (silent if the player's browser is present + offline-charge is enabled, otherwise a TTG
  confirm redirect). On completion the engine derives a settlement from the module's `outcome()` and
  calls TTG `distributePot` — winner-takes-pot by default, split-refund on a draw. Fail-soft.
- **One-way purchase (the store).** A single `charge` with **no pot** — nothing is escrowed or
  refunded. On completion the server grants something in app state; the demo credits **points**
  (`users.points`, shown in the top bar). This is the pattern for selling in-game currency or
  inventory — see [`apps/api/src/payments/points.ts`](apps/api/src/payments/points.ts),
  `POST /payments/purchase`, and [`apps/web/src/routes/Store.tsx`](apps/web/src/routes/Store.tsx).
  Both shapes funnel completions through one idempotent dispatcher (`onIntentResolved`).

The optional `packages/smart-contracts` scaffold is for games that need their **own** on-chain logic
beyond TTG's pots — not the money path. Full walkthrough: [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md).

## License

Add your license here.
