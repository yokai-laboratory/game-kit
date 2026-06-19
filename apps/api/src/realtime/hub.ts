import type { WSContext } from "hono/ws";
import type { GameEvent, RoomResult, RoomView, ServerMessage } from "@game-kit/game-core";
import { env } from "../env.js";
import { logger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Realtime hub -- the realtime fan-out primitive, behind a swappable BACKPLANE seam.
//
// A room's two players may be connected to DIFFERENT API replicas. So instead of fanning out only
// in-process, every room mutation is published to a backplane; each replica relays it to that
// room's LOCAL sockets.
//
//   - MemoryBackplane (default, single machine): publish() loops straight back to the local
//     subscriber. No external dependency.
//   - RedisBackplane (set REDIS_URL): publishes to a Redis channel and a dedicated subscriber
//     relays envelopes from any replica (including self) -- this is what lets you scale the API
//     tier by adding replicas (no sticky sessions needed). `ioredis` is imported lazily so the
//     default path never loads it.
//
// Two payload kinds:
//   - "state"  -> a signal only. Each replica rebuilds the per-seat RoomView from the DB for its
//                 local viewers (views are redacted per seat, so we can't ship one blob for all).
//   - "event" / "completed" -> identical payload for every viewer, fanned out verbatim.
//
// Per-connection messages (presence_state, error, the initial state on connect) are sent directly
// via sendTo() and never touch the backplane.
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

// The swappable seam. publish() ships an envelope to every replica; subscribe() registers the
// handler the backplane invokes for every envelope it observes (from any replica, including self).
interface Backplane {
    publish(env: Envelope): Promise<void>;
    subscribe(onEnvelope: (env: Envelope) => void): void;
}

// Single node: publish loops straight back to the subscribed handler. No external dependency.
class MemoryBackplane implements Backplane {
    private handler: ((env: Envelope) => void) | null = null;

    async publish(env: Envelope): Promise<void> {
        this.handler?.(env);
    }

    subscribe(onEnvelope: (env: Envelope) => void): void {
        this.handler = onEnvelope;
    }
}

// Scale-out: fan envelopes through a Redis pub/sub channel so any replica relays to its local
// sockets. `ioredis` is imported lazily here so the default (memory) path never loads it.
class RedisBackplane implements Backplane {
    private pub: import("ioredis").Redis | null = null;
    private ready: Promise<import("ioredis").Redis>;

    constructor(private url: string) {
        this.ready = this.connect();
    }

    private async connect(): Promise<import("ioredis").Redis> {
        const { Redis } = await import("ioredis");
        this.pub = new Redis(this.url, { maxRetriesPerRequest: null, lazyConnect: false });
        return this.pub;
    }

    async publish(env: Envelope): Promise<void> {
        const pub = this.pub ?? (await this.ready);
        await pub.publish(CHANNEL, JSON.stringify(env));
    }

    subscribe(onEnvelope: (env: Envelope) => void): void {
        void (async () => {
            // A SUBSCRIBE connection can't run normal commands, so the subscriber is its own client.
            const { Redis } = await import("ioredis");
            const sub = new Redis(this.url, { maxRetriesPerRequest: null });
            sub.subscribe(CHANNEL).catch((err: unknown) => logger.error({ err }, "realtime subscribe failed"));
            sub.on("message", (_channel: string, payload: string) => {
                let env: Envelope;
                try {
                    env = JSON.parse(payload) as Envelope;
                } catch {
                    return;
                }
                onEnvelope(env);
            });
        })();
    }
}

const backplane: Backplane = env.REDIS_URL ? new RedisBackplane(env.REDIS_URL) : new MemoryBackplane();

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
        await backplane.publish(env);
    } catch (err) {
        logger.warn({ err, roomId: env.roomId }, "realtime publish failed");
    }
}

// Local fan-out for an envelope received from the backplane (from any replica, including self).
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
    backplane.subscribe((env) => void deliverLocally(env));
    logger.info({ backplane: env.REDIS_URL ? "redis" : "memory" }, "realtime hub subscribed");
}
