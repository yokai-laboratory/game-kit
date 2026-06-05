# Web image: build the Vite SPA, serve it as static files with nginx. Vite/esbuild bundles the
# workspace TypeScript packages (game-core, the game screens) into the static output, so the runtime
# image is just nginx + html. Build context is the REPO ROOT.
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
COPY . .
RUN pnpm install
RUN pnpm --filter @game-kit/web build

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
