---
name: deploy
description: Deploy game-kit to a VPS via Docker Compose, given SSH access. Use when the user wants the app running on a server (a $20 8GB/4vCPU box is the target). Covers preflight, env, bring-up, and verification.
---

# game-kit deploy

Target: a single small VPS (≈8GB / 4vCPU). The base stack (caddy, web, api, postgres, redis) fits in
~1.5GB. This skill assumes you have SSH access to the box and the repo is (or will be) on it.

## 1. Preflight (on the VPS)
Copy the repo to the VPS (`git clone` or `rsync`), then:
```
bash scripts/preflight-vps.sh
```
Resolve any ✗ before continuing. Common fixes: install Docker Engine + the compose plugin; free
ports 80/443; add the user to the `docker` group.

## 2. SDK (no setup needed)
`@metatrongg/sdk` is on the **public npm registry**, so the image build resolves it with a plain
`pnpm install` — no Verdaccio, no private registry, no scope pin.

## 3. Configure env
Either run the setup skill (`pnpm setup` with production values) or:
```
cp deploy/.env.example deploy/.env
```
Then edit `deploy/.env`:
- `DOMAIN` = the real hostname (DNS A/AAAA record must already point at the VPS), `ACME_EMAIL` set →
  Caddy gets a Let's Encrypt cert automatically.
- `WEB_ORIGIN=https://<domain>`, `OAUTH_REDIRECT_URI=https://<domain>/api/auth/callback`.
- Strong `POSTGRES_PASSWORD` + matching `DATABASE_URL`; generated `SESSION_SECRET`
  (`openssl rand -hex 32`).
- All `OAUTH_*` + `TRON_API_ORIGIN` + `PAYMENT_*` from the TRON app.
- **Register `OAUTH_REDIRECT_URI` and the embed origin on the TRON app** (dashboard or API).

## 4. Bring it up
```
cd deploy
docker compose --env-file .env up -d --build
```
This builds the api/web images, runs the one-shot `migrate` job (idempotent schema bootstrap), then
starts everything. Caddy provisions TLS on first request to `DOMAIN`.

## 5. Verify
- `docker compose --env-file .env ps` — all services healthy; `migrate` exited 0.
- `curl -fsS https://<domain>/api/ready` → `{"ok":true,"db":true,"redis":true}` (Caddy strips the
  `/api` prefix, so this hits the API's `/ready`).
- Open `https://<domain>`, sign in with TRON, create a room, and confirm the OAuth + a stake charge
  round-trip works end to end.
- Logs: `docker compose --env-file .env logs -f api`.

## 6. Updates & scaling
- Update: `git pull && docker compose --env-file .env up -d --build` (migrate re-runs idempotently).
- Scale the API on one box: `docker compose --env-file .env up -d --scale api=3` (then switch the
  Caddyfile to dynamic upstreams — see the comment block in `deploy/Caddyfile`).
- Scale across machines: run this compose on each node pointed at a shared Postgres + Redis, and put
  an external load balancer in front.

## Troubleshooting
- **TLS not issued:** DNS not pointing at the box yet, or port 80 blocked (Let's Encrypt HTTP-01).
- **Sign-in fails:** redirect-URI mismatch between TRON app and `OAUTH_REDIRECT_URI`.
- **Build can't find @metatrongg/sdk:** registry not reachable during build (see step 2).
- **api unhealthy:** check `DATABASE_URL`/`REDIS_URL` and that `migrate` succeeded.
