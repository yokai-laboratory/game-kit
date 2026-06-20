---
name: setup
description: Walk the user through provisioning a Metatron (TRON) OAuth app + redirect URIs and writing the env files for game-kit. Use when first standing up the project or when OAuth/payment credentials are missing or wrong.
---

# game-kit setup

Goal: end with valid `apps/api/.env` (local dev) and `deploy/.env` (docker/Railway stack), a Metatron
OAuth app with the correct redirect URI, embed origin, and a **payout address** for the payment chain,
and a verified sign-in.

game-kit is an **external consumer** of Metatron — it provisions itself only through Metatron's
developer surface (the MCP / developer dashboard / the developer REST API under `/me/developer/*`),
never Metatron's source or database.

> Reference: app registration + OAuth are documented at
> [`metatron.gg/docs/developer-console`](https://metatron.gg/docs/developer-console) and
> [`/docs/authentication`](https://metatron.gg/docs/authentication). Agents: the full index is at
> [`metatron.gg/llms.txt`](https://metatron.gg/llms.txt).

## 0. One-time browser bootstrap (required, can't be automated)

Metatron makes these session-only on purpose — a developer key can never mint another key or accept a
policy on your behalf. In the Metatron web app (local dev: `http://localhost:5173`):

1. **Sign in.**
2. **Become a developer** — accept the developer policy (`POST /me/developer/request`). Self-service,
   no admin review locally.
3. **Mint a developer API key** — a `tron_dev_…` token. This is the `TRON_DEV_TOKEN` below.

(On a fresh local stack the dev's **embedded wallet** is what backs the payout address — see step 3.)

## 1. Gather inputs
- **TRON_API_ORIGIN** — base URL of the Metatron API (local dev: `http://localhost:4200`).
- **Domain** — public hostname for production, or `localhost` for local-only.
- **PAYMENT_CHAIN** — e.g. `anvil-local` (local) or `ethereum-sepolia`.
- Whether they have a **`tron_dev_…` token** (enables the automated path).

## 2. Choose the path
- **Preferred — API-driven:** with a `tron_dev_…` token, setup creates the app, sets the redirect URI
  + embed origin, mints a client key, and verifies the payout address.
- **Fallback — guided paste:** otherwise, walk them through the dashboard and paste the
  `client_id` / `client_secret`.

### 2a. API-driven
```
TRON_API_ORIGIN=<origin> DOMAIN=<domain> GAMEKIT_ENV=<development|production> \
PAYMENT_CHAIN=<chain> TRON_DEV_TOKEN=<tron_dev_…> pnpm setup
```
`scripts/setup.ts` calls, in order:
`POST /me/developer/apps {name}` → `PATCH /me/developer/apps/{id} {redirectUris, embedOrigins}` →
`PUT /me/developer/apps/{id}/keys/{env}` → `GET /me/developer` (payout check). Creating the app with
no `chains` makes Metatron **auto-seed the payout address from the developer's embedded wallet** for
each enabled chain, so `payments:charge` is grantable without pasting an address. On any API-shape
mismatch the script falls back to guided paste.

### 2b. Guided paste
In the Metatron developer dashboard:
1. Create an app (environment = development or production).
2. Set its **redirect URI** exactly:
   - production: `https://<domain>/api/auth/callback`
   - local dev: `http://localhost:8788/auth/callback`
3. Add the web origin to **embed origins** (presence widget): `https://<domain>` (or
   `http://localhost:5274` for dev).
4. Ensure a **payout address** exists for `PAYMENT_CHAIN` (defaults to your embedded wallet) — without
   one, `payments:charge` is refused with `invalid_scope`.
5. Generate a key and copy the `client_id` + `client_secret`, then:
```
TRON_API_ORIGIN=<origin> DOMAIN=<domain> GAMEKIT_ENV=<env> PAYMENT_CHAIN=<chain> pnpm setup
```

## 3. What setup writes
- Discovers OAuth endpoints from `<origin>/.well-known/openid-configuration` (falls back to
  `/oauth/authorize|token|userinfo`).
- Generates `SESSION_SECRET` and a Postgres password (for `deploy/.env`).
- Writes `apps/api/.env` (local: `API_PORT=8788`, `DATABASE_URL` for a Postgres you provide, no
  `REDIS_URL`) and `deploy/.env`. It will NOT overwrite existing files unless `GAMEKIT_FORCE=1`.

## 4. Verify
- `pnpm install`, then start a Postgres at `DATABASE_URL` (e.g.
  `docker run -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=game_kit -p 5432:5432 postgres:16`).
- `./scripts/dev.sh` to boot locally, open `http://localhost:5274`, click **Sign in with Metatron**,
  and confirm the OAuth round-trip lands back at `/lobby`.
- If sign-in fails:
  - redirect-URI mismatch (the app's URI and `OAUTH_REDIRECT_URI` must be byte-for-byte identical), or
  - `invalid_scope` → the app has no payout address for `PAYMENT_CHAIN` (set one in the dashboard).

## Notes
- `client_secret` is server-only; it lives in env, never in the web bundle.
- Re-running setup is safe; use `GAMEKIT_FORCE=1` to regenerate env files.
