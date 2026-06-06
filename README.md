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
| `apps/api` — auth, payments, presence, the **generic engine**, the Redis socket hub | `apps/api/src/game/registry.ts` — the list of games |
| `apps/web/src/core` — auth, API client, socket hook, charge/presence UI | `apps/web/src/games/registry.tsx` — gameId → screen |

A game is a `GameModule<State, Move, Config>` (pure, isomorphic logic) plus a React screen. The
generic engine drives any module through the lifecycle — **create → stake → start → moves → complete
→ settle** — without knowing the rules.

## Quickstart (local)

Prereqs: Node 24, pnpm 11, Docker. **And** the `@titanium-games/sdk` registry — see
[SDK prerequisite](#sdk-prerequisite).

```bash
pnpm install
pnpm setup            # wire TTG OAuth keys + write env files (or see the setup skill)
./scripts/dev.sh      # Postgres+Redis in Docker, migrate, then api + web with hot reload
# open http://localhost:5273
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

The API tier is **stateless** — state in Postgres, websocket fan-out via Redis pub/sub — so any
replica serves any socket. Scale up on one box with `docker compose up -d --scale api=3` (switch the
Caddyfile to dynamic upstreams), or run the stack on multiple nodes against shared Postgres + Redis
behind a load balancer.

## Repo layout

```
apps/
  api/           Hono API: auth, payments, presence, generic engine, Redis socket hub
  web/           Vite + React SPA: lobby, room, charge/presence UI, game registry
packages/
  game-core/     The GameModule interface + client/server wire protocol (isomorphic, zod-only)
  smart-contracts/  OPTIONAL Foundry scaffold for custom on-chain logic (TTG handles payments)
games/
  coinflip/      The example game (scrap me): schema + module (logic) + screen (UI)
deploy/          docker-compose (+ observability/anvil/dev overlays), Caddyfile, env example
scripts/         setup.ts (TTG keys), dev.sh, preflight-vps.sh
skills/          agent runbooks: setup, deploy
AGENTS.md        the agent-first contract for this repo
```

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

## How payments work (at a glance)

This repo never holds funds. Stakes flow through TTG:

1. A room mints a CreditVault **pot**; each player stakes into it via TTG `charge` (silent if the
   player's browser is present + offline-charge is enabled, otherwise a TTG confirm redirect).
2. When the game completes, the engine derives a settlement from the module's `outcome()` and calls
   TTG `distributePot` — winner-takes-pot by default, split-refund on a draw. Fail-soft.

The optional `packages/smart-contracts` scaffold is for games that need their **own** on-chain logic
beyond TTG's pots — not the money path.

## License

Add your license here.
