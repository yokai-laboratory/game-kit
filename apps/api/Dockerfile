# API image. Runs the Hono server with tsx directly (no compile step) -- the workspace packages
# (@game-kit/game-core, @game-kit/game-coinflip) are source-only TypeScript, and tsx resolves them
# natively. This keeps the image simple and sidesteps shipping a build of source-only deps.
#
# Build context is the REPO ROOT (see deploy/docker-compose.yml).
#
# @metatrongg/sdk resolves from public npm -- no private registry needed.
FROM node:24-slim

RUN corepack enable
WORKDIR /app

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/

COPY . .
RUN pnpm install

ENV NODE_ENV=production
EXPOSE 8787

# tsx is a devDependency of @game-kit/api; run the server through it.
CMD ["pnpm", "--filter", "@game-kit/api", "exec", "tsx", "src/index.ts"]
