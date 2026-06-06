---
name: setup
description: Walk the user through wiring Titanium Games (TTG) app keys + redirect URIs and writing the env files for game-kit. Use when first standing up the project or when OAuth/payment credentials are missing or wrong.
---

# game-kit setup

Goal: end with valid `apps/api/.env` (local dev) and `deploy/.env` (docker stack), an OAuth app
registered on TTG with the correct redirect URI, and a verified sign-in.

> Reference: app registration + OAuth are documented at
> [`titaniumgames.gg/docs/developer-console`](https://titaniumgames.gg/docs/developer-console) and
> [`/docs/authentication`](https://titaniumgames.gg/docs/authentication). Agents: the full index is at
> [`titaniumgames.gg/llms.txt`](https://titaniumgames.gg/llms.txt).

## 0. Gather inputs
Ask the user (or read from context) for:
- **TTG_API_ORIGIN** — base URL of the Titanium Games API.
- **Domain** — the public hostname for production, or `localhost` for local-only.
- Whether they have a **TTG developer access token** (enables the automated path).

## 1. Choose the path
- **Preferred — API-driven:** if the user can provide a TTG developer access token, you'll create the
  app + rotate a key automatically.
- **Fallback — guided paste:** otherwise, walk them through the TTG developer dashboard and paste the
  `client_id` / `client_secret`.

## 2a. API-driven
Run setup with the token in the environment (it provisions the app, sets the redirect URI, rotates a
key, and writes both env files):

```
TTG_API_ORIGIN=<origin> DOMAIN=<domain> GAMEKIT_ENV=<development|production> \
TTG_DEV_TOKEN=<token> pnpm setup
```

`scripts/setup.ts` calls `POST /me/developer/apps` then `PUT /me/developer/apps/{id}/keys/{env}`.
If the TTG API shape differs and it errors, the script falls back to guided paste automatically —
or you can adjust the request bodies in `scripts/setup.ts` to match the user's TTG API version.

## 2b. Guided paste
Tell the user to, in the TTG developer dashboard:
1. Create an app (environment = development or production).
2. Set its **redirect URI** to exactly:
   - production: `https://<domain>/api/auth/callback`
   - local dev: `http://localhost:8787/auth/callback`
3. Add their web origin to the app's **embed origins** (for the presence widget): `https://<domain>`
   (or `http://localhost:5273` for dev).
4. Generate a key and copy the `client_id` + `client_secret`.

Then run (the script prompts for the two values, or pass them as env vars):
```
TTG_API_ORIGIN=<origin> DOMAIN=<domain> GAMEKIT_ENV=<env> pnpm setup
```

## 3. What setup writes
- Discovers OAuth endpoints from `<origin>/.well-known/openid-configuration` (falls back to
  `/oauth/authorize|token|userinfo`).
- Generates `SESSION_SECRET` and a Postgres password.
- Writes `apps/api/.env` and `deploy/.env`. It will NOT overwrite existing files unless
  `GAMEKIT_FORCE=1` is set — back up or confirm before forcing.

## 4. Verify
- Ensure the SDK registry is reachable (`.npmrc`), then `pnpm install`.
- `./scripts/dev.sh` to boot locally, open `http://localhost:5273`, click **Sign in with Titanium
  Games**, and confirm the OAuth round-trip lands back at `/lobby`.
- If sign-in fails: the #1 cause is a redirect-URI mismatch between the TTG app and
  `OAUTH_REDIRECT_URI` — they must be byte-for-byte identical.

## Notes
- `client_secret` is server-only; it lives in env, never in the web bundle.
- Re-running setup is safe; use `GAMEKIT_FORCE=1` to regenerate env files.
