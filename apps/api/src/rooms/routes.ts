import { Hono } from "hono";
import { z } from "zod";
import { requireUser, type SessionUser } from "../auth/session.js";
import { createRoom, GameError, joinRoom, listHistory, listRooms } from "../game/engine.js";
import { DEFAULT_GAME_ID, getGameModule, listGames } from "../game/registry.js";
import { broadcastState } from "../realtime/hub.js";

export const roomsRoutes = new Hono<{ Variables: { user: SessionUser } }>();

// Public-ish: the catalog of registered games (no auth needed to render the lobby's game picker).
roomsRoutes.get("/games", (c) => c.json({ games: listGames(), defaultGameId: DEFAULT_GAME_ID }));

roomsRoutes.use("*", requireUser);

const createSchema = z.object({
    gameId: z.string().min(1).optional(),
    stakeEth: z
        .string()
        .regex(/^\d+(\.\d{1,18})?$/u, "stake must be a positive decimal amount")
        .refine((s) => Number.parseFloat(s) > 0, "stake must be > 0"),
    // Stake denomination. "eth" prices the stake in decimal ETH (on-chain pot); "tron" prices it in
    // whole TRON ledger credits (1 TRON = 1 cent). Defaults to "eth".
    currency: z.enum(["eth", "tron"]).optional(),
    // Game-specific config, validated against the module's own schema inside the engine.
    config: z.unknown().optional(),
});

roomsRoutes.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "bad_request", issues: parsed.error.issues }, 400);

    const gameId = parsed.data.gameId ?? DEFAULT_GAME_ID;
    if (!getGameModule(gameId)) return c.json({ error: "unknown_game", gameId }, 400);

    const user = c.get("user");
    try {
        const room = await createRoom({
            gameId,
            hostUserId: user.id,
            hostDisplayName: user.displayName,
            stakeEth: parsed.data.stakeEth,
            currency: parsed.data.currency,
            config: parsed.data.config,
        });
        return c.json({ room: { id: room.id, gameId: room.gameId } });
    } catch (e) {
        // A bad game config surfaces as a ZodError from the engine -> 400 with the issue.
        if (e instanceof GameError) return c.json({ error: e.code }, 400);
        if (e instanceof Error && e.name === "ZodError") return c.json({ error: "bad_config", detail: e.message }, 400);
        throw e;
    }
});

const listSchema = z.object({
    gameId: z.string().optional(),
    minStake: z.coerce.number().nonnegative().optional(),
    maxStake: z.coerce.number().positive().optional(),
});

roomsRoutes.get("/", async (c) => {
    const parsed = listSchema.safeParse({
        gameId: c.req.query("gameId"),
        minStake: c.req.query("minStake"),
        maxStake: c.req.query("maxStake"),
    });
    if (!parsed.success) return c.json({ error: "bad_request" }, 400);
    const rooms = await listRooms({ userId: c.get("user").id, ...parsed.data });
    return c.json({ rooms });
});

const historySchema = z.object({ limit: z.coerce.number().int().positive().max(100).optional() });

roomsRoutes.get("/history", async (c) => {
    const parsed = historySchema.safeParse({ limit: c.req.query("limit") });
    if (!parsed.success) return c.json({ error: "bad_request" }, 400);
    const items = await listHistory(c.get("user").id, parsed.data.limit ?? 50);
    return c.json({ items });
});

roomsRoutes.post("/:id/join", async (c) => {
    const id = c.req.param("id");
    try {
        const room = await joinRoom({ roomId: id, guestUserId: c.get("user").id });
        await broadcastState(id);
        return c.json({ room: { id: room.id, gameId: room.gameId } });
    } catch (e) {
        if (e instanceof GameError) return c.json({ error: e.code }, 400);
        throw e;
    }
});
