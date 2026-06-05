import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { GameHistoryItem } from "@game-kit/game-core";
import {
    createRoom,
    joinRoom,
    listGames,
    listHistory,
    listRooms,
    type GameInfo,
    type RoomListItem,
} from "../core/api";
import { useAuth } from "../core/auth";

export function Lobby(): React.JSX.Element {
    const { user } = useAuth();
    const navigate = useNavigate();
    const [games, setGames] = useState<GameInfo[]>([]);
    const [gameId, setGameId] = useState<string>("");
    const [stake, setStake] = useState("0.01");
    const [rooms, setRooms] = useState<RoomListItem[]>([]);
    const [history, setHistory] = useState<GameHistoryItem[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        const [r, h] = await Promise.all([listRooms({}), listHistory(25)]);
        setRooms(r);
        setHistory(h);
    }, []);

    useEffect(() => {
        void listGames().then((g) => {
            setGames(g.games);
            setGameId(g.defaultGameId);
        });
        void refresh();
        const t = setInterval(() => void refresh(), 4000);
        return () => clearInterval(t);
    }, [refresh]);

    const onCreate = async () => {
        setBusy(true);
        setError(null);
        try {
            const room = await createRoom({ gameId, stakeEth: stake });
            navigate(`/room/${room.id}`);
        } catch (e) {
            setError(e instanceof Error ? e.message : "create failed");
        } finally {
            setBusy(false);
        }
    };

    const onJoin = async (id: string) => {
        setBusy(true);
        setError(null);
        try {
            await joinRoom(id);
            navigate(`/room/${id}`);
        } catch (e) {
            setError(e instanceof Error ? e.message : "join failed");
        } finally {
            setBusy(false);
        }
    };

    const selected = games.find((g) => g.id === gameId);

    return (
        <main className="lobby">
            <section className="panel">
                <h2>New match</h2>
                <label>
                    Game
                    <select value={gameId} onChange={(e) => setGameId(e.target.value)}>
                        {games.map((g) => (
                            <option key={g.id} value={g.id}>
                                {g.displayName}
                            </option>
                        ))}
                    </select>
                </label>
                {selected && <p className="muted small">{selected.description}</p>}
                <label>
                    Stake (ETH)
                    <input value={stake} onChange={(e) => setStake(e.target.value)} inputMode="decimal" />
                </label>
                <button className="cta" disabled={busy || !gameId} onClick={() => void onCreate()}>
                    Create &amp; stake
                </button>
                {error && <p className="error">{error}</p>}
            </section>

            <section className="panel">
                <h2>Open rooms</h2>
                {rooms.length === 0 && <p className="muted">No rooms yet — create one.</p>}
                <ul className="room-list">
                    {rooms.map((r) => {
                        const mine = r.hostUserId === user?.id || r.guestUserId === user?.id;
                        return (
                            <li key={r.id}>
                                <span>
                                    <strong>{r.gameId}</strong> · {r.stakeEth} ETH · {r.hostDisplayName} ·{" "}
                                    <span className="muted">{r.status}</span>
                                </span>
                                {mine ? (
                                    <button onClick={() => navigate(`/room/${r.id}`)}>Resume</button>
                                ) : r.status === "waiting" ? (
                                    <button disabled={busy} onClick={() => void onJoin(r.id)}>
                                        Join
                                    </button>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            </section>

            <section className="panel">
                <h2>Your history</h2>
                {history.length === 0 && <p className="muted">No finished games yet.</p>}
                <ul className="history">
                    {history.map((h) => (
                        <li key={h.id}>
                            <span className={`outcome ${h.outcome}`}>{h.outcome}</span> {h.gameId} · {h.stakeEth} ETH ·
                            vs {h.opponent?.displayName ?? "—"}
                        </li>
                    ))}
                </ul>
            </section>
        </main>
    );
}
