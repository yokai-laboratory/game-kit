# API image. Runs the Hono server with tsx directly (no compile step) -- the workspace packages
# (@game-kit/game-core, @game-kit/game-coinflip) are source-only TypeScript, and tsx resolves them
# natively. This keeps the image simple and sidesteps shipping a build of source-only deps.
#
# Build context is the REPO ROOT (see deploy/docker-compose.yml). Same image serves the migrate job.
#
# SDK NOTE: `@titanium-games/sdk` resolves from the registry in .npmrc (default: a local Verdaccio).
# The build must be able to reach it. On a VPS, either run Verdaccio and build with host networking
# (compose sets `network: host` for this build) or publish the SDK to a registry the build can see
# and override via the NPM_CONFIG_REGISTRY build arg / a mounted .npmrc.
FROM node:24-slim

RUN corepack enable
WORKDIR /app

# Public-registry override for everything except the @titanium-games scope (which .npmrc pins).
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/

COPY . .
RUN pnpm install

ENV NODE_ENV=production
EXPOSE 8787

# tsx is a devDependency of @game-kit/api; run the server through it.
CMD ["pnpm", "--filter", "@game-kit/api", "exec", "tsx", "src/index.ts"]
