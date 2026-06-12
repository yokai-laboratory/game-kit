import type { Context } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import type { ClientMessage } from "@game-kit/game-core";
import { loadSessionUser } from "../auth/session.js";
import { logger } from "../logger.js";
import { type PlayerPresence, type PlaySessionGameStatus, startGameHalfPresence } from "../presence/ttg-presence.js";
import { type Conn, register, sendTo, unregister } from "../realtime/hub.js";
import { applyInput, applyMove, buildRoomView, getRoomRow, GameError } from "./engine.js";
import { ensureTicking } from "./ticker.js";

// The room WebSocket. Generic over the game: it relays `move` messages to the engine (which drives
// the active GameModule) and `presence` messages to the game-half handshake. All game-specific
// logic lives in the GameModule -- this handler never imports a game.
export async function roomWsHandler(c: Context): Promise<WSEvents> {
    const roomId = c.req.param("id");
    const user = await loadSessionUser(c);

    if (!roomId || !user) {
        return {
            onOpen(_ev, ws) {
                ws.send(JSON.stringify({ type: "error", message: "unauthorized" }));
                ws.close(1008, "unauthorized");
            },
        };
    }

    const room = await getRoomRow(roomId);
    if (!room || (room.hostUserId !== user.id && room.guestUserId !== user.id)) {
        return {
            onOpen(_ev, ws) {
                ws.send(JSON.stringify({ type: "error", message: "not_a_participant" }));
                ws.close(1008, "not_a_participant");
            },
        };
    }

    const conn: Conn = { ws: null as unknown as WSContext, userId: user.id, roomId };

    // Active-play presence: GAME half only. The browser widget drives the user half and relays its
    // minted playSessionId; we confirm + heartbeat the game half with the app's credentials.
    let presence: PlayerPresence | null = null;
    let currentPlaySessionId: string | null = null;
    let roomClosed = false;
    let presenceActive = false;
    const pushPresenceActive = (active: boolean): void => {
        if (active === presenceActive) return;
        presenceActive = active;
        sendTo(conn, { type: "presence_state", active });
    };
    const onPresenceStatus = (status: PlaySessionGameStatus): void => pushPresenceActive(status === "active");
    const stopPresence = (): void => {
        roomClosed = true;
        void presence?.stop();
        presence = null;
        currentPlaySessionId = null;
        pushPresenceActive(false);
    };
    const onPresenceRelay = (playSessionId: string): void => {
        if (roomClosed || playSessionId === currentPlaySessionId) return;
        void presence?.stop();
        presence = null;
        currentPlaySessionId = playSessionId;
        void startGameHalfPresence(user.id, playSessionId, onPresenceStatus).then((started) => {
            if (roomClosed || currentPlaySessionId !== playSessionId) {
                void started?.stop();
                return;
            }
            presence = started;
        });
    };

    return {
        async onOpen(_ev, ws) {
            conn.ws = ws;
            register(conn);
            const view = await buildRoomView(roomId, user.id);
            if (view) sendTo(conn, { type: "state", view });
            // Realtime rooms: every socket open is a wake signal (no-op for turn-based rooms and
            // while another replica's lease is live) -- resumes the loop after a restart.
            await ensureTicking(roomId);
        },
        async onMessage(ev, ws) {
            conn.ws = ws;
            let msg: ClientMessage;
            try {
                msg = JSON.parse(String(ev.data)) as ClientMessage;
            } catch {
                sendTo(conn, { type: "error", message: "bad_json" });
                return;
            }
            if (msg.type === "presence") {
                onPresenceRelay(msg.playSessionId);
                return;
            }
            if (msg.type === "move") {
                try {
                    await applyMove({ roomId, userId: user.id, moveInput: msg.move });
                    // applyMove broadcasts state/events/completion over the Redis hub itself.
                } catch (e) {
                    if (e instanceof GameError) sendTo(conn, { type: "error", message: e.code });
                    else {
                        logger.error({ err: e, roomId }, "move handler threw");
                        sendTo(conn, { type: "error", message: "internal_error" });
                    }
                }
            }
            if (msg.type === "input") {
                try {
                    // Silent on success: realtime state arrives with the next server tick.
                    await applyInput({ roomId, userId: user.id, inputPayload: msg.input });
                } catch (e) {
                    if (e instanceof GameError) sendTo(conn, { type: "error", message: e.code });
                    else {
                        logger.error({ err: e, roomId }, "input handler threw");
                        sendTo(conn, { type: "error", message: "internal_error" });
                    }
                }
            }
        },
        onClose() {
            stopPresence();
            unregister(conn);
        },
        onError() {
            stopPresence();
            unregister(conn);
        },
    };
}
