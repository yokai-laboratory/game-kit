import type { WSContext } from "hono/ws";
import type { GameEvent, RoomResult, RoomView, ServerMessage } from "@game-kit/game-core";
import { createRedisSubscriber, redis } from "../redis.js";
import { logger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Realtime hub -- the horizontal-scaling primitive.
//
// A room's two players may be connected to DIFFERENT API replicas. So instead of an in-process
// registry, every room mutation is published to a Redis channel; each replica's subscriber relays
// it to that room's LOCAL sockets. Result: any replica can serve any socket, and you scale the API
// tier by adding replicas (no sticky sessions needed).
//
// Two payload kinds:
//   - "state"  -> a signal only. Each replica rebuilds the per-seat RoomView from Postgres for its
//                 local viewers (views are redacted per seat, so we can't ship one blob for all).
//   - "event" / "completed" -> identical payload for every viewer, fanned out verbatim.
//
// Per-connection messages (presence_state, error, the initial state on connect) are sent directly
// via sendTo() and never touch Redis.
// ─────────────────────────────────────────────────────────────────────────────

const CHANNEL = "gk:room";

export interface Conn {
    ws: WSContext;
    userId: string;
    roomId: string;
}

type Envelope =
    | { roomId: string; kind: "state" }
    | { roomId: string; kind: "event"; event: GameEvent }
    | { roomId: string; kind: "completed"; result: RoomResult };

// Rebuilds the redacted per-seat view. Injected at startup to avoid a hub<->engine import cycle.
type ViewBuilder = (roomId: string, userId: string) => Promise<RoomView | null>;

const connsByRoom = new Map<string, Set<Conn>>();
let buildView: ViewBuilder | null = null;
let started = false;

export function setViewBuilder(fn: ViewBuilder): void {
    buildView = fn;
}

export function register(conn: Conn): void {
    let set = connsByRoom.get(conn.roomId);
    if (!set) {
        set = new Set();
        connsByRoom.set(conn.roomId, set);
    }
    set.add(conn);
}

export function unregister(conn: Conn): void {
    const set = connsByRoom.get(conn.roomId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) connsByRoom.delete(conn.roomId);
}

export function sendTo(conn: Conn, msg: ServerMessage): void {
    try {
        conn.ws.send(JSON.stringify(msg));
    } catch {
        // socket may be closing -- best-effort
    }
}

// Publish a "room state changed" signal. Every replica (including this one) rebuilds + pushes the
// per-seat view to its local sockets via the subscriber below.
export async function broadcastState(roomId: string): Promise<void> {
    await publish({ roomId, kind: "state" });
}

export async function broadcastEvent(roomId: string, event: GameEvent): Promise<void> {
    await publish({ roomId, kind: "event", event });
}

export async function broadcastCompleted(roomId: string, result: RoomResult): Promise<void> {
    await publish({ roomId, kind: "completed", result });
}

async function publish(env: Envelope): Promise<void> {
    try {
        await redis.publish(CHANNEL, JSON.stringify(env));
    } catch (err) {
        logger.warn({ err, roomId: env.roomId }, "realtime publish failed");
    }
}

// Local fan-out for an envelope received from Redis (originating from any replica, including self).
async function deliverLocally(env: Envelope): Promise<void> {
    const set = connsByRoom.get(env.roomId);
    if (!set || set.size === 0) return;

    if (env.kind === "state") {
        if (!buildView) return;
        for (const conn of set) {
            try {
                const view = await buildView(env.roomId, conn.userId);
                if (view) sendTo(conn, { type: "state", view });
            } catch {
                // viewer is no longer a participant -- skip
            }
        }
        return;
    }

    const msg: ServerMessage =
        env.kind === "event" ? { type: "event", event: env.event } : { type: "completed", result: env.result };
    for (const conn of set) sendTo(conn, msg);
}

export function startRealtimeHub(): void {
    if (started) return;
    started = true;
    const sub = createRedisSubscriber();
    sub.subscribe(CHANNEL).catch((err: unknown) => logger.error({ err }, "realtime subscribe failed"));
    sub.on("message", (_channel: string, payload: string) => {
        let env: Envelope;
        try {
            env = JSON.parse(payload) as Envelope;
        } catch {
            return;
        }
        void deliverLocally(env);
    });
    logger.info("realtime hub subscribed");
}
