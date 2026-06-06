import { useEffect, useRef, useState } from "react";
import type { ClientMessage, GameEvent, RoomView, ServerMessage } from "@game-kit/game-core";

// Generic room socket. Game-agnostic: it carries the redacted RoomView (whose `game.state` shape is
// owned by the active game) and a `submitMove(move)` that sends an opaque move the server validates.
// Reveal/animation cues arrive as `lastEvent`.
export interface RoomConnection {
    view: RoomView | null;
    error: string | null;
    submitMove: (move: unknown) => void;
    lastEvent: GameEvent | null;
    // Relay the TTG presence widget's minted playSessionId to the server (it drives the game half).
    relayPresence: (playSessionId: string) => void;
    // Server-derived presence: true only while BOTH halves are fresh. The Room defers an offline-
    // eligible stake charge until this is true so it isn't fired into a guaranteed redirect.
    presenceActive: boolean;
}

export function useRoomSocket(roomId: string | null): RoomConnection {
    const [view, setView] = useState<RoomView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [lastEvent, setLastEvent] = useState<GameEvent | null>(null);
    const [presenceActive, setPresenceActive] = useState(false);
    const wsRef = useRef<WebSocket | null>(null);
    // Latest playSessionId the presence widget reported; (re)sent on every (re)open.
    const pendingPresenceRef = useRef<string | null>(null);

    useEffect(() => {
        if (!roomId) return;
        let cleanedUp = false;
        let attempts = 0;
        let retry: ReturnType<typeof setTimeout> | null = null;

        const connect = (): void => {
            const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
            const ws = new WebSocket(`${proto}//${window.location.host}/ws/room/${roomId}`);
            wsRef.current = ws;

            ws.onopen = () => {
                attempts = 0;
                setError(null);
                // (Re)assert presence on every open so a reconnect re-establishes the game half.
                if (pendingPresenceRef.current !== null) {
                    ws.send(JSON.stringify({ type: "presence", playSessionId: pendingPresenceRef.current }));
                }
            };
            ws.onmessage = (ev) => {
                const msg = JSON.parse(ev.data) as ServerMessage;
                if (msg.type === "state") setView(msg.view);
                else if (msg.type === "event") setLastEvent(msg.event);
                else if (msg.type === "presence_state") setPresenceActive(msg.active);
                else if (msg.type === "completed") {
                    // The next `state` carries the terminal room.result; nothing else to do here.
                } else if (msg.type === "error") setError(msg.message);
            };
            // Don't surface raw onerror -- onclose drives reconnect + the (eventual) error, so a
            // StrictMode/HMR remount or a brief blip doesn't flash a scary message.
            ws.onerror = () => {};
            ws.onclose = () => {
                if (cleanedUp) return; // our own cleanup closed it -- not an error
                setPresenceActive(false);
                attempts += 1;
                // Only call it an error once a few reconnects have failed; transient drops self-heal.
                if (attempts >= 3) setError("connection_error");
                const delay = Math.min(1000 * attempts, 5000);
                retry = setTimeout(connect, delay);
            };
        };

        connect();

        return () => {
            cleanedUp = true;
            if (retry) clearTimeout(retry);
            wsRef.current?.close();
            wsRef.current = null;
            // The server tears the play session down on socket close; mirror that so a remount
            // starts un-gated rather than trusting a stale `active`.
            setPresenceActive(false);
        };
    }, [roomId]);

    const submitMove = (move: unknown) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const msg: ClientMessage = { type: "move", move };
        ws.send(JSON.stringify(msg));
    };

    const relayPresence = (playSessionId: string) => {
        pendingPresenceRef.current = playSessionId;
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
            const msg: ClientMessage = { type: "presence", playSessionId };
            ws.send(JSON.stringify(msg));
        }
    };

    return { view, error, submitMove, lastEvent, relayPresence, presenceActive };
}
