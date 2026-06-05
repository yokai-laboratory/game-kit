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
    const pendingPresenceRef = useRef<string | null>(null);

    useEffect(() => {
        if (!roomId) return;
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${proto}//${window.location.host}/ws/room/${roomId}`);
        wsRef.current = ws;
        ws.onopen = () => {
            if (pendingPresenceRef.current !== null) {
                const msg: ClientMessage = { type: "presence", playSessionId: pendingPresenceRef.current };
                ws.send(JSON.stringify(msg));
            }
        };
        ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data) as ServerMessage;
            if (msg.type === "state") setView(msg.view);
            else if (msg.type === "event") setLastEvent(msg.event);
            else if (msg.type === "presence_state") setPresenceActive(msg.active);
            else if (msg.type === "completed") {
                // The next `state` carries the terminal room.result; nothing else needed here.
            } else if (msg.type === "error") setError(msg.message);
        };
        ws.onerror = () => setError("connection_error");
        return () => {
            ws.close();
            wsRef.current = null;
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
