# API image. Runs the Hono server with tsx directly (no compile step) -- the workspace packages
# (@game-kit/game-core, @game-kit/game-coinflip) are source-only TypeScript, and tsx resolves them
# natively. This keeps the image simple and sidesteps shipping a build of source-only deps.
#
# Build context is the REPO ROOT (see deploy/docker-compose.yml).
#
# SDK NOTE: `@titanium-games/sdk` resolves from the registry in .npmrc (default: a local Verdaccio).
# The build must be able to reach it. On a VPS, either run Verdaccio and build with host networking
# (compose sets `network: host` for this build) or publish the SDK to a registry the build can see
# and override via the NPM_CONFIG_REGISTRY build arg / a mounted .npmrc.
FROM node:24-slim

# better-sqlite3 is a native addon. node:24-slim ships no toolchain, and there isn't always a
# prebuilt binary for this platform/Node ABI, so install python3 + a C/C++ toolchain so node-gyp can
# compile it during `pnpm install`. (If a prebuilt is fetched these go unused but cost only build time.)
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

# Public-registry override for everything except the @titanium-games scope (which .npmrc pins).
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/

COPY . .
RUN pnpm install

ENV NODE_ENV=production
# Persist SQLite outside the container layer (compose mounts the sqlite_data volume here and sets
# SQLITE_PATH=/data/game-kit.sqlite). Pre-create the dir so the first boot can write the WAL files.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8787

# tsx is a devDependency of @game-kit/api; run the server through it.
CMD ["pnpm", "--filter", "@game-kit/api", "exec", "tsx", "src/index.ts"]
