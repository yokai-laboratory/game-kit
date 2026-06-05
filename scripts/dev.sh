#!/usr/bin/env bash
# Local dev: bring up Postgres + Redis (containers), run migrations, then start the api + web with
# hot reload on the host. Ctrl-C stops the dev servers; the backing containers keep running (stop
# them with: docker compose -f deploy/docker-compose.dev.yml down).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f apps/api/.env ]; then
    echo "apps/api/.env not found. Run 'pnpm setup' first (or copy apps/api/.env.example)." >&2
    exit 1
fi

echo "▶ starting postgres + redis…"
docker compose -f deploy/docker-compose.dev.yml up -d --wait

echo "▶ running migrations…"
pnpm --filter @game-kit/api run db:migrate

echo "▶ starting api + web (turbo)…"
exec pnpm dev
