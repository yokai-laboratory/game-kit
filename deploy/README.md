# Deploying game-kit

Single-VPS Docker Compose deploy. Target: ~8GB/4vCPU; the base stack fits in ~1.5GB. The **deploy
skill** (`skills/deploy`) is the step-by-step agent runbook; this is the reference.

## Stack

`docker-compose.yml` defines:

| Service | Role |
| --- | --- |
| `caddy` | TLS (auto Let's Encrypt) + single-origin routing (80/443) |
| `web` | static SPA (nginx) |
| `api` | Hono server. State is a single SQLite file on the `sqlite_data` volume; realtime fan-out is in-process |

Routing through Caddy: `/api/*` → api (prefix stripped), `/ws/*` → api (websocket), `/*` → web.

This is a single-machine stack with no external backing services (no Postgres, no Redis). The schema
bootstraps itself on first boot — there is no migration step.

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

The default stack is single-machine: SQLite is one file (can't be shared across replicas) and the
realtime backplane + tick lease are in-process (dedupe only within one process). So `--scale api=N`
does **not** work as-is. To scale the API tier horizontally you must:

1. Set `REDIS_URL` (re-enables the Redis backplane + tick lease — the swappable seams in
   `apps/api/src/realtime/hub.ts` and `apps/api/src/game/ticker.ts`), and add a `redis` service.
2. Move persistence off single-file SQLite to a shared database (e.g. Postgres) reachable by every
   replica, and repoint the db client.

Both were the original design and are documented extension points; the single-machine default just
removes the external dependencies.

## The SDK at build time

`@metatrongg/sdk` is on the public npm registry, so image builds resolve it with a plain
`pnpm install` — nothing to configure.

## Notes

- `caddy_data` (certs) and `sqlite_data` (the SQLite file) are named volumes; back up `sqlite_data`
  for durable state.
- `deploy/.env` is gitignored — never commit it.
