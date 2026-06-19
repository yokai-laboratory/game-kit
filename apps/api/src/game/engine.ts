import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";
import { randomBytes } from "node:crypto";
import type {
    AnyGameModule,
    GameEvent,
    GameHistoryItem,
    Outcome,
    PlayerRef,
    PublicUser,
    RoomMeta,
    RoomResult,
    RoomView,
    Seat,
} from "@game-kit/game-core";
import { db, schema } from "../db/client.js";
import { logger } from "../logger.js";
import { getCompletedStakeIntents, type IntentRow } from "../payments/intents.js";
import { creditPurchaseIfCompleted } from "../payments/points.js";
import { broadcastCompleted, broadcastEvent, broadcastState } from "../realtime/hub.js";
import { getGameModule } from "./registry.js";
import { cryptoRng } from "./rng.js";
import { settleRoom } from "./settlement.js";

// ─────────────────────────────────────────────────────────────────────────────
// The generic game engine -- a PRIMITIVE. It drives any GameModule through the room lifecycle
// (create -> stake -> start -> moves -> complete -> settle) without knowing any game's rules. All
// game-specific behaviour comes from the registered GameModule; the engine only persists state,
// validates I/O against the module's schemas, enforces turn concurrency, and fans results out over
// the Redis hub. You should rarely need to touch this file when building a game.
// ─────────────────────────────────────────────────────────────────────────────

export type RoomRow = typeof schema.rooms.$inferSelect;

export class GameError extends Error {
    constructor(public code: string) {
        super(code);
    }
}

export async function getRoomRow(roomId: string): Promise<RoomRow | undefined> {
    const rows = await db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId)).limit(1);
    return rows[0];
}

async function getUser(id: string): Promise<typeof schema.users.$inferSelect | undefined> {
    const rows = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    return rows[0];
}

function requireModule(gameId: string): AnyGameModule {
    const module = getGameModule(gameId);
    if (!module) throw new GameError("unknown_game");
    return module;
}

// Validate the persisted blob against the module's schema before handing it to game code -- a cheap
// guard that turns a corrupted/old state row into a clean error instead of undefined-explosions.
function parseState(module: AnyGameModule, raw: unknown): unknown {
    return module.schema.state.parse(raw);
}

function seatOf(room: RoomRow, userId: string): Seat | null {
    if (room.hostUserId === userId) return "host";
    if (room.guestUserId === userId) return "guest";
    return null;
}

export async function createRoom(input: {
    gameId: string;
    hostUserId: string;
    hostDisplayName: string;
    stakeEth: string;
    config?: unknown;
}): Promise<RoomRow> {
    const module = requireModule(input.gameId);
    // Merge the request's config over the module's defaultConfig, then validate. This lets a game's
    // config schema use required fields (no zod defaults) while create requests can still omit them.
    const mergedConfig = {
        ...(module.defaultConfig as Record<string, unknown>),
        ...((input.config as Record<string, unknown> | undefined) ?? {}),
    };
    const config = module.schema.config.parse(mergedConfig);

    const id = nanoid(12);
    const now = Date.now();
    // Fresh bytes16 CreditVault pot per room; both players stake into it.
    const potId = `0x${randomBytes(16).toString("hex")}`;

    const host: PlayerRef = { userId: input.hostUserId, seat: "host", displayName: input.hostDisplayName };
    const state = module.createInitialState({ roomId: id, host, config });

    await db.insert(schema.rooms).values({
        id,
        gameId: input.gameId,
        hostUserId: input.hostUserId,
        guestUserId: null,
        stakeEth: input.stakeEth,
        status: "awaiting_host_stake",
        resultKind: "pending",
        winnerUserId: null,
        potId,
        state,
        lastMoveSeat: null,
        createdAt: now,
        updatedAt: now,
    });
    const row = await getRoomRow(id);
    if (!row) throw new Error("room insert race");
    return row;
}

export async function joinRoom(input: { roomId: string; guestUserId: string }): Promise<RoomRow> {
    const room = await getRoomRow(input.roomId);
    if (!room) throw new GameError("room_not_found");
    if (room.status !== "waiting") throw new GameError("room_not_joinable");
    if (room.hostUserId === input.guestUserId) throw new GameError("cannot_join_own_room");

    await db
        .update(schema.rooms)
        .set({ guestUserId: input.guestUserId, status: "awaiting_guest_stake", updatedAt: Date.now() })
        .where(eq(schema.rooms.id, room.id));
    const updated = await getRoomRow(room.id);
    if (!updated) throw new Error("room missing after join");
    return updated;
}

// Called after an intent flips to completed (events socket or poll backstop). Returns true when the
// room transitioned (caller should broadcast). Idempotent.
export async function advanceRoomAfterStakes(roomId: string): Promise<boolean> {
    const room = await getRoomRow(roomId);
    if (!room) return false;

    if (room.status === "awaiting_host_stake") {
        const stakes = await getCompletedStakeIntents(roomId);
        if (!stakes.some((s) => s.userId === room.hostUserId)) return false;
        await db
            .update(schema.rooms)
            .set({ status: "waiting", updatedAt: Date.now() })
            .where(eq(schema.rooms.id, room.id));
        return true;
    }

    if (room.status === "awaiting_guest_stake") {
        if (!room.guestUserId) return false;
        const stakes = await getCompletedStakeIntents(roomId);
        const hostPaid = stakes.some((s) => s.userId === room.hostUserId);
        const guestPaid = stakes.some((s) => s.userId === room.guestUserId);
        if (!hostPaid || !guestPaid) return false;

        // Both staked -> begin the match. Hand the module both players + an RNG and persist the
        // live starting state.
        const module = requireModule(room.gameId);
        const [host, guest] = await Promise.all([getUser(room.hostUserId), getUser(room.guestUserId)]);
        const hostRef: PlayerRef = {
            userId: room.hostUserId,
            seat: "host",
            displayName: host?.displayName ?? "host",
        };
        const guestRef: PlayerRef = {
            userId: room.guestUserId,
            seat: "guest",
            displayName: guest?.displayName ?? "guest",
        };
        const started = module.start(parseState(module, room.state), {
            roomId,
            host: hostRef,
            guest: guestRef,
            rng: cryptoRng(),
        });
        await db
            .update(schema.rooms)
            .set({ status: "in_progress", state: started, updatedAt: Date.now() })
            .where(eq(schema.rooms.id, room.id));
        return true;
    }

    return false;
}

// Realtime waker, injected at startup (ticker -> engine would otherwise be an import cycle).
// Called whenever a room (re)enters in_progress so the tick loop starts the moment a realtime
// match begins -- ws.ts also calls the ticker on socket open, which covers resume-after-restart.
type RealtimeWaker = (roomId: string) => Promise<void>;
let wakeRealtime: RealtimeWaker | null = null;

export function setRealtimeWaker(fn: RealtimeWaker): void {
    wakeRealtime = fn;
}

// Single entry point for "a payment intent just reached a terminal state". Every completion path --
// the synchronous charge/purchase response, the TTG events socket, the poll backstop, the
// return-page sync -- funnels the resolved intent row through here so the two intent kinds share one
// reaction: a completed stake advances its room; a completed purchase credits its points. Both
// branches are idempotent, so duplicate observations (multi-replica sockets, poll overlap) are safe.
export async function onIntentResolved(intent: IntentRow): Promise<void> {
    if (intent.status !== "completed") return;
    if (intent.kind === "purchase") {
        await creditPurchaseIfCompleted(intent.id);
        return;
    }
    if (!intent.roomId) return;
    const advanced = await advanceRoomAfterStakes(intent.roomId);
    if (advanced) {
        await broadcastState(intent.roomId);
        await wakeRealtime?.(intent.roomId);
    }
}

// Apply a player's move. Wrapped in a row-locked transaction (SELECT ... FOR UPDATE) so concurrent
// moves -- possibly arriving at different API replicas -- serialize on the room row. Throws
// GameError on any rejection (the WS handler relays the code to the submitting socket). On success
// it broadcasts the new state + any events over the Redis hub, and fires settlement on completion.
export async function applyMove(input: { roomId: string; userId: string; moveInput: unknown }): Promise<void> {
    // better-sqlite3 transactions are synchronous: the callback runs to completion inside one
    // BEGIN/COMMIT and the tx query builders return their results directly (no await). On a single
    // SQLite handle this serializes writers, which gives us the same room-row serialization the
    // Postgres `SELECT ... FOR UPDATE` provided.
    const tx = db.transaction((txn) => {
        const rows = txn.select().from(schema.rooms).where(eq(schema.rooms.id, input.roomId)).limit(1).all();
        const room = rows[0];
        if (!room) throw new GameError("room_not_found");
        if (room.status !== "in_progress") throw new GameError("room_not_in_progress");

        const seat = seatOf(room, input.userId);
        if (!seat) throw new GameError("not_a_participant");

        const module = requireModule(room.gameId);
        const state = parseState(module, room.state);
        const parsedMove = module.schema.move.safeParse(input.moveInput);
        if (!parsedMove.success) throw new GameError("bad_move");

        const rng = cryptoRng();
        const validation = module.validateMove(state, parsedMove.data, { roomId: input.roomId, by: seat, rng });
        if (!validation.ok) throw new GameError(validation.code);

        const applied = module.applyMove(state, parsedMove.data, { roomId: input.roomId, by: seat, rng });
        const nextState = applied.state;
        const complete = module.isComplete(nextState);
        const outcome: Outcome = complete ? module.outcome(nextState) : { kind: "pending" };
        const winnerUserId =
            outcome.kind === "win" ? (outcome.winner === "host" ? room.hostUserId : room.guestUserId) : null;

        txn
            .update(schema.rooms)
            .set({
                state: nextState,
                lastMoveSeat: seat,
                updatedAt: Date.now(),
                ...(complete ? { status: "completed", resultKind: outcome.kind, winnerUserId } : {}),
            })
            .where(eq(schema.rooms.id, room.id))
            .run();

        return { room, module, nextState, complete, outcome, winnerUserId, events: applied.events ?? [] };
    });

    await fanOutTransition(input.roomId, tx);
}

// Shared post-commit fan-out for every state transition (move or tick): broadcast over the Redis
// hub, then fire settlement when the transition completed the game.
interface AppliedTransition {
    room: RoomRow;
    module: AnyGameModule;
    nextState: unknown;
    complete: boolean;
    outcome: Outcome;
    winnerUserId: string | null;
    events: GameEvent[];
}

async function fanOutTransition(roomId: string, tx: AppliedTransition): Promise<void> {
    // (Redis hub -> every replica -> local sockets.)
    await broadcastState(roomId);
    for (const event of tx.events) await broadcastEvent(roomId, event);

    if (tx.complete) {
        const result: RoomResult =
            tx.outcome.kind === "win" ? { kind: "win", winnerUserId: tx.winnerUserId ?? "" } : { kind: "draw" };
        await broadcastCompleted(roomId, result);
        // Fire-and-forget: settlement relays an on-chain distribution that can take seconds; never
        // block the broadcast (and thus the live UI) on it. settleRoom is fully fail-soft.
        void settleRoom({
            roomId,
            potId: tx.room.potId,
            stakeEth: tx.room.stakeEth,
            hostUserId: tx.room.hostUserId,
            guestUserId: tx.room.guestUserId,
            outcome: tx.outcome,
            module: tx.module,
            state: tx.nextState,
            gameDisplayName: tx.module.displayName,
        }).catch((err: unknown) => logger.warn({ err, roomId }, "settleRoom threw"));
    }
}

// Apply one realtime input. Same row-locked serialization as a move, but silent: nothing
// broadcasts (the tick is the fan-out cadence) and completion is only ever decided by a tick.
// Mirrors the TTG hosted-game semantics so a game graduates between the two without redesign.
export async function applyInput(input: { roomId: string; userId: string; inputPayload: unknown }): Promise<void> {
    db.transaction((txn) => {
        const rows = txn.select().from(schema.rooms).where(eq(schema.rooms.id, input.roomId)).limit(1).all();
        const room = rows[0];
        if (!room) throw new GameError("room_not_found");
        if (room.status !== "in_progress") throw new GameError("room_not_in_progress");

        const seat = seatOf(room, input.userId);
        if (!seat) throw new GameError("not_a_participant");

        const module = requireModule(room.gameId);
        if (!module.realtime || !module.applyInput) throw new GameError("inputs_not_supported");

        const state = parseState(module, room.state);
        let payload = input.inputPayload;
        if (module.schema.input) {
            const parsed = module.schema.input.safeParse(input.inputPayload);
            if (!parsed.success) throw new GameError("bad_input");
            payload = parsed.data;
        }

        let nextState: unknown;
        try {
            nextState = module.applyInput(state, payload, { roomId: input.roomId, by: seat, rng: cryptoRng() });
        } catch {
            throw new GameError("input_rejected");
        }

        txn
            .update(schema.rooms)
            .set({ state: nextState, lastMoveSeat: seat, updatedAt: Date.now() })
            .where(eq(schema.rooms.id, room.id))
            .run();
    });
}

// Advance a realtime room by one server tick. Returns "ticked" while the game continues; anything
// else tells the ticker to stop its loop ("stopped" = room gone / not in progress / not realtime).
export async function tickRoom(roomId: string, dtMs: number): Promise<"ticked" | "completed" | "stopped"> {
    const tx = db.transaction((txn): AppliedTransition | null => {
        const rows = txn.select().from(schema.rooms).where(eq(schema.rooms.id, roomId)).limit(1).all();
        const room = rows[0];
        if (!room || room.status !== "in_progress") return null;

        const module = requireModule(room.gameId);
        if (!module.realtime || !module.tick) return null;

        const state = parseState(module, room.state);
        const applied = module.tick(state, dtMs, { roomId, rng: cryptoRng() });
        const nextState = applied.state;
        const complete = module.isComplete(nextState);
        const outcome: Outcome = complete ? module.outcome(nextState) : { kind: "pending" };
        const winnerUserId =
            outcome.kind === "win" ? (outcome.winner === "host" ? room.hostUserId : room.guestUserId) : null;

        txn
            .update(schema.rooms)
            .set({
                state: nextState,
                updatedAt: Date.now(),
                ...(complete ? { status: "completed", resultKind: outcome.kind, winnerUserId } : {}),
            })
            .where(eq(schema.rooms.id, room.id))
            .run();

        return { room, module, nextState, complete, outcome, winnerUserId, events: applied.events ?? [] };
    });

    if (!tx) return "stopped";
    await fanOutTransition(roomId, tx);
    return tx.complete ? "completed" : "ticked";
}

function toRoomMeta(room: RoomRow, hostName: string, guestName: string | null): RoomMeta {
    const result: RoomResult =
        room.resultKind === "pending"
            ? { kind: "pending" }
            : room.resultKind === "draw"
              ? { kind: "draw" }
              : { kind: "win", winnerUserId: room.winnerUserId ?? "" };
    return {
        id: room.id,
        gameId: room.gameId,
        hostUserId: room.hostUserId,
        hostDisplayName: hostName,
        guestUserId: room.guestUserId,
        guestDisplayName: guestName,
        stakeEth: room.stakeEth,
        status: room.status,
        result,
        createdAt: room.createdAt,
    };
}

// Build the redacted per-seat view for one viewer. Returns null when the viewer isn't a participant
// (the hub uses null to skip a stale socket cleanly).
export async function buildRoomView(roomId: string, viewerUserId: string): Promise<RoomView | null> {
    const room = await getRoomRow(roomId);
    if (!room) return null;
    const seat = seatOf(room, viewerUserId);
    if (!seat) return null;

    const module = requireModule(room.gameId);
    const [host, guest] = await Promise.all([
        getUser(room.hostUserId),
        room.guestUserId ? getUser(room.guestUserId) : Promise.resolve(undefined),
    ]);

    const you: PublicUser =
        seat === "host"
            ? { id: room.hostUserId, displayName: host?.displayName ?? "host" }
            : { id: room.guestUserId ?? "", displayName: guest?.displayName ?? "guest" };
    const opponent: PublicUser | null =
        seat === "host"
            ? guest
                ? { id: guest.id, displayName: guest.displayName }
                : null
            : host
              ? { id: host.id, displayName: host.displayName }
              : null;

    const gameView = module.view(parseState(module, room.state), seat);

    return {
        room: toRoomMeta(room, host?.displayName ?? "host", guest?.displayName ?? null),
        you,
        opponent,
        seat,
        game: { id: room.gameId, state: gameView },
    };
}

// Lobby list: joinable `waiting` rooms (any host) + the caller's own pre-completed rooms.
export interface RoomListItem {
    id: string;
    gameId: string;
    stakeEth: string;
    status: RoomRow["status"];
    hostUserId: string;
    hostDisplayName: string;
    guestUserId: string | null;
    createdAt: number;
}

export async function listRooms(input: {
    userId: string;
    gameId?: string;
    minStake?: number;
    maxStake?: number;
}): Promise<RoomListItem[]> {
    const visibility = or(
        eq(schema.rooms.status, "waiting"),
        and(
            inArray(schema.rooms.status, ["awaiting_host_stake", "awaiting_guest_stake", "in_progress"]),
            or(eq(schema.rooms.hostUserId, input.userId), eq(schema.rooms.guestUserId, input.userId)),
        ),
    );
    const filters = [visibility];
    if (input.gameId) filters.push(eq(schema.rooms.gameId, input.gameId));
    if (input.minStake !== undefined) {
        filters.push(sql`CAST(${schema.rooms.stakeEth} AS REAL) >= ${input.minStake}`);
    }
    if (input.maxStake !== undefined) {
        filters.push(sql`CAST(${schema.rooms.stakeEth} AS REAL) <= ${input.maxStake}`);
    }
    return db
        .select({
            id: schema.rooms.id,
            gameId: schema.rooms.gameId,
            stakeEth: schema.rooms.stakeEth,
            status: schema.rooms.status,
            hostUserId: schema.rooms.hostUserId,
            hostDisplayName: schema.users.displayName,
            guestUserId: schema.rooms.guestUserId,
            createdAt: schema.rooms.createdAt,
        })
        .from(schema.rooms)
        .innerJoin(schema.users, eq(schema.users.id, schema.rooms.hostUserId))
        .where(and(...filters))
        .orderBy(desc(schema.rooms.createdAt));
}

export async function listHistory(userId: string, limit: number): Promise<GameHistoryItem[]> {
    const host = alias(schema.users, "host_user");
    const guest = alias(schema.users, "guest_user");

    const rows = await db
        .select({
            id: schema.rooms.id,
            gameId: schema.rooms.gameId,
            stakeEth: schema.rooms.stakeEth,
            hostUserId: schema.rooms.hostUserId,
            guestUserId: schema.rooms.guestUserId,
            resultKind: schema.rooms.resultKind,
            winnerUserId: schema.rooms.winnerUserId,
            createdAt: schema.rooms.createdAt,
            updatedAt: schema.rooms.updatedAt,
            hostDisplayName: host.displayName,
            guestDisplayName: guest.displayName,
        })
        .from(schema.rooms)
        .innerJoin(host, eq(host.id, schema.rooms.hostUserId))
        .leftJoin(guest, eq(guest.id, schema.rooms.guestUserId))
        .where(
            and(
                eq(schema.rooms.status, "completed"),
                or(eq(schema.rooms.hostUserId, userId), eq(schema.rooms.guestUserId, userId)),
            ),
        )
        .orderBy(desc(schema.rooms.updatedAt))
        .limit(limit);

    return rows.map((r) => {
        const role: Seat = r.hostUserId === userId ? "host" : "guest";
        const opponentId = role === "host" ? r.guestUserId : r.hostUserId;
        const opponentName = role === "host" ? r.guestDisplayName : r.hostDisplayName;
        const outcome: GameHistoryItem["outcome"] =
            r.resultKind === "draw" ? "draw" : r.winnerUserId === userId ? "win" : "loss";
        return {
            id: r.id,
            gameId: r.gameId,
            stakeEth: r.stakeEth,
            role,
            opponent: opponentId ? { id: opponentId, displayName: opponentName ?? "" } : null,
            outcome,
            finishedAt: r.updatedAt,
            createdAt: r.createdAt,
        };
    });
}
