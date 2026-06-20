#!/usr/bin/env bash
# Local dev: start the api + web with hot reload on the host. State is Postgres (apps/api/.env's
# DATABASE_URL) -- this script does NOT start a database; bring your own (e.g. a local postgres:16
# container) and point DATABASE_URL at it. The schema auto-bootstraps on first boot (CREATE TABLE IF
# NOT EXISTS in apps/api/src/db/client.ts) -- no migration step. Besides Postgres the api also reaches
# the Metatron (tron) api for auth + payments. Redis is optional (set REDIS_URL only to scale out).
# Ctrl-C stops the dev servers.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f apps/api/.env ]; then
    echo "apps/api/.env not found. Run 'pnpm setup' first (or copy apps/api/.env.example)." >&2
    exit 1
fi

echo "▶ starting api + web (turbo)…"
exec pnpm dev
