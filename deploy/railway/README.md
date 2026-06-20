# Railway deploy (the managed / automated path)

This directory is the Railway target for game-kit: **web + api + Postgres + Redis**, deployed into the
**creator's own** Railway workspace. It is what the Metatron MCP `provision_stack` tool instantiates
(see metatron **#349**). The creator owns and pays for the Railway project; Metatron never hosts or
pays for it. Railway terminates TLS and routes, so there is **no Caddy** here — Caddy only exists for
the self-hosted `docker-compose` (BYOC) path one directory up.

## Files

| File            | Role                                                                                  |
| --------------- | ------------------------------------------------------------------------------------- |
| `api.json`      | Railway config-as-code for the **api** service: Dockerfile build + `/health` check.   |
| `web.json`      | Railway config-as-code for the **web** service: Dockerfile build + `/` check.         |
| `template.json` | Topology + env-wiring **descriptor** the MCP reads to create the Railway template.     |

Both services build from the existing monorepo Dockerfiles with the repo root as context, so each
Railway service uses the repo root as its root directory and points its config path at the file above.

## Env wiring (auto, not hand-entered)

- `DATABASE_URL` ← Railway Postgres plugin (`${{Postgres.DATABASE_URL}}`)
- `REDIS_URL` ← Railway Redis plugin (`${{Redis.REDIS_URL}}`)
- `SESSION_SECRET` ← Railway-generated secret
- `WEB_ORIGIN` / `OAUTH_REDIRECT_URI` ← the web service's public domain
- `OAUTH_*`, `TRON_API_ORIGIN`, `PAYMENT_*` ← injected by the MCP from the creator's Metatron
  developer app (metatron#349 env auto-wiring)

## Single-origin routing (decided)

`web` is the **only public** service and proxies `/api` + `/ws` to the **private** `api` service over
Railway private networking — mirroring what Caddy did on the BYOC path, so the SPA keeps calling
relative `/api` + `/ws` (no CORS, no build-time API URL). The routing lives in
[`apps/web/nginx.conf.template`](../../apps/web/nginx.conf.template): `/api/*` is proxied with the
prefix **stripped**, `/ws/*` with it **preserved** + websocket upgrade. The upstream is filled at
container start from `API_UPSTREAM`, set here to `api`'s private domain.

So: deploy `api` as a **private** service (no public domain), `web` as **public**, and set
`API_UPSTREAM=${{api.RAILWAY_PRIVATE_DOMAIN}}:8787` on `web`. The storefront **Play** URL is `web`'s
public domain.
