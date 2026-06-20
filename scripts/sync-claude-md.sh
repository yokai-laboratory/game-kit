#!/usr/bin/env bash
# AGENTS.md is canon. CLAUDE.md is a generated copy so Claude Code reads the same instructions other
# harnesses get from AGENTS.md. CLAUDE.md is gitignored (a harness-local adapter). Run this after
# editing AGENTS.md to refresh the copy.
set -euo pipefail
cd "$(dirname "$0")/.."
cp AGENTS.md CLAUDE.md
