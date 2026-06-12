import { randomBytes } from "node:crypto";
import { logger } from "../logger.js";
import { redis } from "../redis.js";
import { getRoomRow, tickRoom } from "./engine.js";
import { getGameModule } from "./registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Realtime tick loops -- a PRIMITIVE. When a module declares `realtime`, exactly one API replica
// drives each in_progress room's simulation: a Redis lease (first-wins, refreshed every tick,
// expiring on crash) pins the loop, while moves/inputs/sockets stay replica-agnostic exactly like
// turn-based play. Every tick persists state through the row-locked transaction in tickRoom, so a
// crashed driver loses at most one tick and the next replica that observes the room (socket open,
// stake completion) resumes it.
//
// Wake sites: the engine calls the waker when a room flips in_progress; ws.ts calls it on every
// socket open (covering resume after a restart or lease expiry). Both are idempotent.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TICK_RATE_HZ = 20;
const DEFAULT_TICK_RATE_HZ = 10;
const LEASE_TTL_MS = 5000;
// Ceiling on dt, in tick intervals: scheduler jitter must not turn into a simulation fast-forward.
const MAX_DT_INTERVALS = 2;

const HOLDER = `api-${randomBytes(6).toString("hex")}`;
const leaseKey = (roomId: string): string => `gk:room-tick:${roomId}`;

interface Runner {
    timer: ReturnType<typeof setInterval> | null;
    intervalMs: number;
    lastTickAt: number;
    busy: boolean;
}

const runners = new Map<string, Runner>();

async function releaseLease(roomId: string): Promise<void> {
    // Compare-and-delete: never free a lease another replica has since claimed.
    await redis.eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
        1,
        leaseKey(roomId),
        HOLDER,
    );
}

async function stop(roomId: string, release: boolean): Promise<void> {
    const runner = runners.get(roomId);
    if (!runner) return;
    if (runner.timer) clearInterval(runner.timer);
    runner.timer = null;
    runners.delete(roomId);
    if (release) await releaseLease(roomId);
}

async function fire(roomId: string): Promise<void> {
    const runner = runners.get(roomId);
    if (!runner || runner.busy) return;
    runner.busy = true;
    try {
        // Refresh only while we still hold the lease; losing it means another replica owns the
        // simulation now (our lease expired under a stall) -- yield immediately.
        const refreshed = await redis.eval(
            `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) end return 0`,
            1,
            leaseKey(roomId),
            HOLDER,
            String(LEASE_TTL_MS),
        );
        if (refreshed !== 1) {
            logger.warn({ roomId }, "tick lease lost; stopping loop");
            await stop(roomId, false);
            return;
        }

        const dtMs = Math.min(Date.now() - runner.lastTickAt, runner.intervalMs * MAX_DT_INTERVALS);
        runner.lastTickAt = Date.now();
        const result = await tickRoom(roomId, dtMs);
        if (result !== "ticked") await stop(roomId, true);
    } catch (err) {
        logger.error({ err, roomId }, "tick loop failed; stopping");
        await stop(roomId, true);
    } finally {
        const live = runners.get(roomId);
        if (live) live.busy = false;
    }
}

// Idempotent: start this replica's tick loop for a room iff it's an in_progress realtime room and
// the lease is free (or already ours). Safe to call from every socket open.
export async function ensureTicking(roomId: string): Promise<void> {
    if (runners.has(roomId)) return;
    const room = await getRoomRow(roomId);
    if (!room || room.status !== "in_progress") return;
    const module = getGameModule(room.gameId);
    if (!module?.realtime || !module.tick) return;

    const claimed = await redis.eval(
        `local current = redis.call("get", KEYS[1])
        if current == false or current == ARGV[1] then
            redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2])
            return 1
        end
        return 0`,
        1,
        leaseKey(roomId),
        HOLDER,
        String(LEASE_TTL_MS),
    );
    if (claimed !== 1) return;
    if (runners.has(roomId)) return; // a concurrent ensureTicking won the local race

    const rate = Math.min(Math.max(module.realtime.tickRateHz ?? DEFAULT_TICK_RATE_HZ, 1), MAX_TICK_RATE_HZ);
    const runner: Runner = { timer: null, intervalMs: Math.round(1000 / rate), lastTickAt: Date.now(), busy: false };
    runner.timer = setInterval(() => void fire(roomId), runner.intervalMs);
    runners.set(roomId, runner);
    logger.info({ roomId, intervalMs: runner.intervalMs }, "realtime tick loop started");
}
