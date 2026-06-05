#!/usr/bin/env bash
# Run ON the target VPS before deploying. Verifies the box can host the stack: Docker + compose
# present, ports 80/443 free, enough RAM/disk. Exits non-zero on any hard failure so the deploy
# skill can stop early. Safe to run repeatedly.
set -uo pipefail

fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }

echo "game-kit VPS preflight"

# Docker
if command -v docker >/dev/null 2>&1; then
    ok "docker: $(docker --version 2>/dev/null)"
    if docker info >/dev/null 2>&1; then ok "docker daemon reachable"; else bad "docker daemon not reachable (need sudo, or add user to docker group)"; fi
else
    bad "docker not installed (install Docker Engine + compose plugin)"
fi

# Compose plugin
if docker compose version >/dev/null 2>&1; then
    ok "docker compose: $(docker compose version --short 2>/dev/null)"
else
    bad "docker compose plugin missing"
fi

# Ports 80/443 free
for port in 80 443; do
    if (command -v ss >/dev/null 2>&1 && ss -ltn "( sport = :$port )" 2>/dev/null | grep -q LISTEN) \
        || (command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1); then
        bad "port $port already in use (stop the conflicting service or change the Caddy ports)"
    else
        ok "port $port free"
    fi
done

# RAM (>= ~1.8GB recommended for the base stack)
mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)
mem_mb=$((mem_kb / 1024))
if [ "$mem_mb" -ge 1800 ]; then ok "RAM: ${mem_mb}MB"; elif [ "$mem_mb" -gt 0 ]; then warn "RAM: ${mem_mb}MB (base stack wants ~1.8GB; skip the observability overlay)"; else warn "could not read RAM"; fi

# Disk on / (>= 5GB free)
avail_kb=$(df -Pk / 2>/dev/null | awk 'NR==2{print $4}')
avail_gb=$(( ${avail_kb:-0} / 1024 / 1024 ))
if [ "$avail_gb" -ge 5 ]; then ok "disk free on /: ${avail_gb}GB"; else warn "disk free on /: ${avail_gb}GB (images + volumes want a few GB)"; fi

# git (to pull the repo)
command -v git >/dev/null 2>&1 && ok "git present" || warn "git not installed (needed to clone the repo)"

echo
if [ "$fail" -ne 0 ]; then
    echo "preflight: FAILED — resolve the ✗ items above before deploying." >&2
    exit 1
fi
echo "preflight: OK"
