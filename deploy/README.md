# Deploying game-kit

Single-VPS Docker Compose deploy (the **BYOC** path). For the managed path — the same stack into your
own Railway workspace via the Metatron MCP — see [`railway/README.md`](railway/README.md). Target:
~8GB/4vCPU; the base stack fits in ~1.5GB. The **deploy skill** (`skills/deploy`) is the step-by-step
agent runbook; this is the reference.

## Stack

`docker-compose.yml` defines:

| Service | Role |
| --- | --- |
| `caddy` | TLS (auto Let's Encrypt) + single-origin routing (80/443) |
| `web` | static SPA (nginx) |
| `api` | Hono server (stateless). Persists to `postgres`; realtime fan-out + tick lease via `redis` |
| `postgres` | shared state on the `postgres_data` volume — the row-locked store the engine serializes on |
| `redis` | websocket backplane + tick lease, so the `api` tier can run multiple replicas |

Routing through Caddy: `/api/*` → api (prefix stripped), `/ws/*` → api (websocket), `/*` → web.

`api` is stateless — Postgres holds all state and Redis carries the realtime backplane — so the tier
scales horizontally. The schema bootstraps itself on first boot (`CREATE TABLE IF NOT EXISTS`) — there
is no migration step.

## Steps

```bash
# on the VPS, in the repo:
bash scripts/preflight-vps.sh                 # docker, ports 80/443, RAM/disk
cp deploy/.env.example deploy/.env            # or: pnpm setup
$EDITOR deploy/.env                           # DOMAIN, TRON keys, strong secrets
cd deploy
docker compose --env-file .env up -d --build
docker compose --env-file .env ps             # all healthy
curl -fsS https://<domain>/api/ready          # {"ok":true,"db":true}
```

DNS for `DOMAIN` must point at the VPS before first request so Caddy can complete the ACME HTTP-01
challenge. Register `OAUTH_REDIRECT_URI` (= `https://<domain>/api/auth/callback`) and your web origin
(embed origin) on the TRON developer app.

## Overlays

```bash
# observability (Grafana LGTM + OTel collector, ~1-2GB):
docker compose -f docker-compose.yml -f docker-compose.observability.yml --env-file .env up -d
# local Anvil chain (for packages/smart-contracts):
docker compose -f docker-compose.yml -f docker-compose.anvil.yml --env-file .env up -d anvil
```

## Updates

```bash
git pull
docker compose --env-file .env up -d --build   # schema bootstraps idempotently on boot
```

## Scaling

The stack ships scale-ready: `api` is stateless (Postgres for state, Redis for the realtime backplane
+ tick lease), so you can run replicas behind Caddy with no sticky sessions — any replica serves any
socket:

```bash
docker compose --env-file .env up -d --scale api=N
```

The compose wires `REDIS_URL`, so the Redis seams (`apps/api/src/realtime/hub.ts`,
`apps/api/src/game/ticker.ts`) are already active. Unsetting `REDIS_URL` falls back to the in-process
backplane — the single-replica path used in local dev, where `ioredis` is never imported.

## The SDK at build time

`@metatrongg/sdk` is on the public npm registry, so image builds resolve it with a plain
`pnpm install` — nothing to configure.

## Notes

- `caddy_data` (certs) and `postgres_data` (the database) are named volumes; back up `postgres_data`
  for durable state.
- `deploy/.env` is gitignored — never commit it.
