# Deploying game-kit

Single-VPS Docker Compose deploy. Target: ~8GB/4vCPU; the base stack fits in ~1.5GB. The **deploy
skill** (`skills/deploy`) is the step-by-step agent runbook; this is the reference.

## Stack

`docker-compose.yml` defines:

| Service | Role |
| --- | --- |
| `caddy` | TLS (auto Let's Encrypt) + single-origin routing (80/443) |
| `web` | static SPA (nginx) |
| `api` | Hono server, stateless, `--scale`-able |
| `migrate` | one-shot idempotent schema bootstrap, runs before `api` |
| `postgres` | durable state |
| `redis` | websocket fan-out + cache |

Routing through Caddy: `/api/*` → api (prefix stripped), `/ws/*` → api (websocket), `/*` → web.

## Steps

```bash
# on the VPS, in the repo:
bash scripts/preflight-vps.sh                 # docker, ports 80/443, RAM/disk
cp deploy/.env.example deploy/.env            # or: pnpm setup
$EDITOR deploy/.env                           # DOMAIN, TTG keys, strong secrets
cd deploy
docker compose --env-file .env up -d --build
docker compose --env-file .env ps             # all healthy; migrate exited 0
curl -fsS https://<domain>/api/ready          # {"ok":true,"db":true,"redis":true}
```

DNS for `DOMAIN` must point at the VPS before first request so Caddy can complete the ACME HTTP-01
challenge. Register `OAUTH_REDIRECT_URI` (= `https://<domain>/api/auth/callback`) and your web origin
(embed origin) on the TTG developer app.

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
docker compose --env-file .env up -d --build   # migrate re-runs idempotently
```

## Scaling

- One box: `docker compose --env-file .env up -d --scale api=3`, then switch the two
  `reverse_proxy api:8787` lines in `Caddyfile` to the dynamic-upstreams block (commented there).
- Many boxes: run this compose on each node pointed at a **shared** Postgres + Redis (move them out
  of compose or point `DATABASE_URL`/`REDIS_URL` at managed instances), and put an external LB in
  front. The API is stateless, so this just works.

## The SDK at build time

Image builds need `@titanium-games/sdk` from the registry in `.npmrc`. The api/web builds use
`network: host`, so a Verdaccio on the VPS at `localhost:4873` is reachable; or publish the SDK to a
private registry and repoint the scope (and `NPM_CONFIG_REGISTRY` if your default registry changes
too). See the root README's "SDK prerequisite".

## Notes

- Postgres/Redis aren't published to the host — only the app containers reach them.
- `caddy_data` (certs), `pg_data`, `redis_data` are named volumes; back up `pg_data` for durable
  state.
- `deploy/.env` is gitignored — never commit it.
