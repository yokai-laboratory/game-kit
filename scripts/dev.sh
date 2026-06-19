#!/usr/bin/env bash
# Local dev: start the api + web with hot reload on the host. State is a single SQLite file
# (apps/api/.env's SQLITE_PATH, default ./data/game-kit.sqlite), created on first boot -- no backing
# containers and no migration step. The default path connects to nothing external except the ttg api.
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
