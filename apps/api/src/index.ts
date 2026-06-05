import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { authRoutes } from "./auth/oauth.js";
import { loadSessionUser } from "./auth/session.js";
import { roomsRoutes } from "./rooms/routes.js";
import { paymentsRoutes } from "./payments/routes.js";
import { startTtgEventsSocket } from "./payments/ttg-socket.js";
import { startPollBackstop } from "./payments/poll-backstop.js";
import { roomWsHandler } from "./game/ws.js";
import { buildRoomView } from "./game/engine.js";
import { setViewBuilder, startRealtimeHub } from "./realtime/hub.js";
import { pingDb } from "./db/client.js";
import { pingRedis } from "./redis.js";

const app = new Hono();

app.use(
    "*",
    cors({
        origin: env.WEB_ORIGIN,
        credentials: true,
    }),
);

// Liveness: process is up. Used by the container healthcheck + Caddy upstream check.
app.get("/health", (c) => c.json({ ok: true }));

// Readiness: shared deps reachable. Caddy/orchestrators gate traffic on this.
app.get("/ready", async (c) => {
    const [db, redis] = await Promise.all([pingDb(), pingRedis()]);
    const ok = db && redis;
    return c.json({ ok, db, redis }, ok ? 200 : 503);
});

app.route("/auth", authRoutes);
app.route("/rooms", roomsRoutes);
app.route("/payments", paymentsRoutes);

app.get("/me", async (c) => {
    const user = await loadSessionUser(c);
    return c.json({ user });
});

// Active-play presence: hands the web app the TTG api origin + our public client_id so it can mount
// TTG's origin-isolated presence widget. Neither value is secret.
app.get("/presence/config", (c) =>
    c.json({ ttgApiOrigin: new URL(env.TTG_API_ORIGIN).origin, clientId: env.OAUTH_CLIENT_ID }),
);

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
app.get(
    "/ws/room/:id",
    upgradeWebSocket((c) => roomWsHandler(c)),
);

// Wire the realtime hub: it rebuilds per-seat views via the engine, and subscribes to Redis so any
// replica can deliver room updates to its local sockets.
setViewBuilder(buildRoomView);
startRealtimeHub();

const server = serve({ fetch: app.fetch, port: env.API_PORT }, (info) => {
    logger.info({ port: info.port, env: env.NODE_ENV }, "game-kit api listening");
});

injectWebSocket(server);

// Background payment subscribers: the live events socket + the polling backstop.
startTtgEventsSocket();
startPollBackstop();

// Graceful shutdown so the load balancer drains us cleanly on a rolling deploy.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        logger.info({ signal }, "shutting down");
        server.close(() => process.exit(0));
        // Hard cap so a stuck connection can't hang the deploy.
        setTimeout(() => process.exit(0), 5000).unref();
    });
}
