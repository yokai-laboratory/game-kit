import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { GameHistoryItem } from "@game-kit/game-core";
import {
    createRoom,
    getPreflight,
    joinRoom,
    listGames,
    listHistory,
    listRooms,
    type GameInfo,
    type Preflight,
    type RoomListItem,
} from "../core/api";
import { useAuth } from "../core/auth";
import { useChrome } from "../core/shell/chrome";
import { GameSurface } from "../core/shell/GameSurface";
import { ShellHeader } from "../core/shell/ShellHeader";
import { Avatar } from "../core/ui/Avatar";
import { CtxLink, MenuButton } from "../core/ui/Menu";
import { PresenceWidget } from "../core/PresenceWidget";
import { useCharge } from "../core/use-charge";
import { useRoomSocket } from "../core/ws";
import { getGameScreen } from "../games/registry";

// The Play hub — the shell's three-column pattern with the game full screen behind it:
//   left   menu: New match / Open matches
//   centre the active tab — or the live room (?room=<id>) when one is open
//   right  context: at-a-glance stats + jump links
// Rooms live INSIDE this page: create/join puts ?room= on the URL, staking happens in the centre
// card, and the registered game screen renders there once the match is live. Games with engine
// clients can take rounds fullscreen via core/shell/FullscreenStage.

type Tab = "new" | "matches";

function usd(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
}

export function Play(): React.JSX.Element {
    const { user } = useAuth();
    const { setImmersive } = useChrome();
    const [params, setParams] = useSearchParams();
    const roomId = params.get("room");

    const [tab, setTab] = useState<Tab>("new");
    const [games, setGames] = useState<GameInfo[]>([]);
    const [gameId, setGameId] = useState<string>("");
    const [currency, setCurrency] = useState<"tron" | "eth">("tron");
    const [stake, setStake] = useState("100");
    const [rooms, setRooms] = useState<RoomListItem[]>([]);
    const [history, setHistory] = useState<GameHistoryItem[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [preflight, setPreflight] = useState<Preflight | null>(null);
    const [widgetStatus, setWidgetStatus] = useState<string | null>(null);
    const [widgetEpoch, setWidgetEpoch] = useState(0);
    const [widgetAuthed, setWidgetAuthed] = useState<boolean | null>(null);

    // The room living inside this page.
    const { view, error: socketError, submitMove, submitInput, lastEvent, relayPresence, presenceActive } =
        useRoomSocket(roomId);
    const { status: chargeStatus, charge } = useCharge();
    const status = view?.room.status;
    const seat = view?.seat;
    const youOweStake =
        (status === "awaiting_host_stake" && seat === "host") || (status === "awaiting_guest_stake" && seat === "guest");

    // Pages flip immersive themselves when a fullscreen stage is up; the demo game plays in-panel,
    // so this page never does. (See FullscreenStage for the engine-client pattern.)
    useEffect(() => () => setImmersive(false), [setImmersive]);

    const openRoom = useCallback(
        (id: string | null) => {
            setPreflight(null);
            setParams(id ? { room: id } : {}, { replace: false });
        },
        [setParams],
    );

    const refresh = useCallback(async () => {
        try {
            const [r, h] = await Promise.all([listRooms({}), listHistory(15)]);
            setRooms(r);
            setHistory(h);
        } catch {
            /* transient */
        }
    }, []);

    useEffect(() => {
        void listGames().then((g) => {
            setGames(g.games);
            setGameId(g.defaultGameId);
        });
        void refresh();
        const t = setInterval(() => void refresh(), 5000);
        return () => clearInterval(t);
    }, [refresh]);

    useEffect(() => {
        if (!roomId || !youOweStake) return;
        void getPreflight(roomId)
            .then(setPreflight)
            .catch(() => setPreflight(null));
    }, [roomId, youOweStake]);

    const guard = async (fn: () => Promise<void>): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
            await fn();
        } catch (e) {
            setError(e instanceof Error ? e.message : "something went wrong");
        } finally {
            setBusy(false);
        }
    };

    const onCreate = (): Promise<void> =>
        guard(async () => {
            const room = await createRoom({ gameId, stakeEth: stake, currency });
            openRoom(room.id);
        });

    const onJoin = (id: string): Promise<void> =>
        guard(async () => {
            await joinRoom(id);
            openRoom(id);
        });

    const mine = rooms.filter((r) => r.hostUserId === user?.id || r.guestUserId === user?.id);
    const joinable = rooms.filter((r) => r.status === "waiting" && r.hostUserId !== user?.id);
    const isTron = view?.room.currency === "tron";
    const selected = games.find((g) => g.id === gameId);
    const Screen = view ? getGameScreen(view.game.id) : undefined;

    return (
        <>
            <GameSurface gameId={gameId || undefined} />
            <ShellHeader
                title="Play"
                left={
                    <div className="welcome" style={{ margin: 0 }}>
                        <Avatar url={user?.avatarUrl} name={user?.displayName ?? "?"} size={34} presence />
                        <div className="name" style={{ fontSize: 15 }}>
                            {user?.displayName}
                        </div>
                    </div>
                }
                right={<span className="chip">◆ {user?.points ?? 0}</span>}
            />

            <main className="overlay" style={{ position: "relative", zIndex: 10 }}>
                <div className="shell-columns">
                    <div className="divider left" aria-hidden />
                    <div className="divider right" aria-hidden />

                    {/* ── LEFT — menu ─────────────────────────────────────── */}
                    <aside className="shell-menu">
                        <div className="menu-group">
                            <p className="group-label">Play</p>
                            <MenuButton
                                icon="⚔️"
                                label="New match"
                                hint="Create & join"
                                active={tab === "new"}
                                onClick={() => setTab("new")}
                            />
                            <MenuButton
                                icon="🕹️"
                                label="Open matches"
                                hint={`${mine.length} in flight`}
                                active={tab === "matches"}
                                onClick={() => setTab("matches")}
                            />
                        </div>
                    </aside>

                    {/* ── CENTRE — the live room, or the active tab ───────── */}
                    <section className="shell-content">
                        {error && <p className="error">{error}</p>}
                        {socketError && <p className="error">socket: {socketError}</p>}

                        {roomId ? (
                            !view ? (
                                <section className="panel">Connecting…</section>
                            ) : (
                                <section className="panel">
                                    <div className="room-head" style={{ marginBottom: 8 }}>
                                        <h3 style={{ margin: 0 }}>
                                            {view.game.id} · {view.room.stakeEth} {isTron ? "TRON" : "ETH"}
                                        </h3>
                                        <button className="link" onClick={() => openRoom(null)}>
                                            Close
                                        </button>
                                    </div>
                                    <p className="muted small" style={{ marginTop: 0 }}>
                                        {view.you.displayName} vs {view.opponent?.displayName ?? "…"}
                                    </p>

                                    {/* Stake step */}
                                    {youOweStake && (
                                        <>
                                            {preflight && (
                                                <p className="muted small">
                                                    {isTron
                                                        ? `${view.room.stakeEth} TRON (${usd(preflight.stake.usdCents)}) · settles instantly`
                                                        : `${view.room.stakeEth} ETH ≈ ${usd(preflight.stake.usdCents)}`}
                                                </p>
                                            )}
                                            <PresenceWidget
                                                key={widgetEpoch}
                                                onPlaySessionId={relayPresence}
                                                onStatus={(s) => {
                                                    setWidgetStatus(s);
                                                    if (s === "ended") setTimeout(() => setWidgetEpoch((n) => n + 1), 800);
                                                }}
                                                onAuthChange={setWidgetAuthed}
                                            />
                                            <p className="muted small">
                                                presence:{" "}
                                                {presenceActive
                                                    ? "active ✓ (instant stakes enabled)"
                                                    : widgetAuthed === false
                                                      ? "sign in to the platform in this browser to enable instant stakes"
                                                      : (widgetStatus ?? "…")}
                                            </p>
                                            {chargeStatus.kind === "insufficient_tron" && (
                                                <p className="error">
                                                    Not enough TRON: balance {chargeStatus.balanceCents}, need{" "}
                                                    {chargeStatus.requiredCents}. Top up, then retry.
                                                </p>
                                            )}
                                            {chargeStatus.kind === "limit_exceeded" ? (
                                                <a className="cta" href={chargeStatus.redirectUrl}>
                                                    Raise cap &amp; pay
                                                </a>
                                            ) : (
                                                <button
                                                    className="cta"
                                                    disabled={
                                                        chargeStatus.kind === "requesting" ||
                                                        chargeStatus.kind === "redirecting"
                                                    }
                                                    onClick={() => void charge(roomId)}
                                                >
                                                    {chargeStatus.kind === "requesting" ? "Charging…" : "Stake & play"}
                                                </button>
                                            )}
                                            {chargeStatus.kind === "error" && <p className="error">{chargeStatus.message}</p>}
                                        </>
                                    )}

                                    {!youOweStake &&
                                        (status === "awaiting_host_stake" || status === "awaiting_guest_stake") && (
                                            <p className="muted">Waiting for your opponent to stake…</p>
                                        )}
                                    {status === "waiting" && (
                                        <p className="muted">
                                            Staked ✓ — waiting for an opponent. You can close this and keep browsing.
                                        </p>
                                    )}

                                    {/* The game itself — the registered screen for this room's module. */}
                                    {(status === "in_progress" || status === "completed") &&
                                        (Screen ? (
                                            <Screen
                                                view={view.game.state}
                                                seat={view.seat}
                                                you={view.you}
                                                opponent={view.opponent}
                                                status={view.room.status}
                                                result={view.room.result}
                                                submitMove={submitMove}
                                                submitInput={submitInput}
                                                lastEvent={lastEvent}
                                            />
                                        ) : (
                                            <p className="error">No screen registered for game "{view.game.id}".</p>
                                        ))}
                                </section>
                            )
                        ) : (
                            <div className="swap" key={tab}>
                                {tab === "new" && (
                                    <div className="panel">
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
                                            Currency
                                            <select
                                                value={currency}
                                                onChange={(e) => {
                                                    const next = e.target.value as "tron" | "eth";
                                                    setCurrency(next);
                                                    // Platform charge floor is 99 ledger cents (1 TRON = 1¢).
                                                    setStake(next === "tron" ? "100" : "0.01");
                                                }}
                                            >
                                                <option value="tron">TRON (ledger · instant)</option>
                                                <option value="eth">ETH (on-chain)</option>
                                            </select>
                                        </label>
                                        <label>
                                            Stake ({currency === "tron" ? "whole TRON, min 99" : "ETH"})
                                            <input
                                                value={stake}
                                                onChange={(e) => setStake(e.target.value)}
                                                inputMode={currency === "tron" ? "numeric" : "decimal"}
                                            />
                                        </label>
                                        <div style={{ marginTop: 14 }}>
                                            <button className="cta" disabled={busy || !gameId} onClick={() => void onCreate()}>
                                                Create &amp; stake
                                            </button>
                                        </div>

                                        <h3 style={{ marginTop: 22, fontSize: 15 }}>Waiting for an opponent</h3>
                                        {joinable.length === 0 && (
                                            <p className="muted small">Nobody waiting — create one.</p>
                                        )}
                                        <div>
                                            {joinable.map((r) => (
                                                <div className="social-row" key={r.id}>
                                                    <Avatar url={r.hostAvatarUrl} name={r.hostDisplayName} size={38} />
                                                    <span className="who">
                                                        <span className="name">{r.hostDisplayName}</span>
                                                        <span className="sub">{r.gameId}</span>
                                                    </span>
                                                    <span className="money">
                                                        <span className="stake">
                                                            {r.stakeEth} {r.currency === "tron" ? "TRON" : "ETH"}
                                                        </span>
                                                    </span>
                                                    <button disabled={busy} onClick={() => void onJoin(r.id)}>
                                                        Join
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {tab === "matches" && (
                                    <>
                                        <div className="panel">
                                            <h2>Open matches</h2>
                                            {mine.length === 0 && (
                                                <p className="muted small">Nothing in flight — start one.</p>
                                            )}
                                            <div>
                                                {mine.map((r) => (
                                                    <div className="social-row" key={r.id}>
                                                        <Avatar url={r.hostAvatarUrl} name={r.hostDisplayName} size={38} />
                                                        <span className="who">
                                                            <span className="name">{r.hostDisplayName}</span>
                                                            <span className="sub">
                                                                {r.gameId} · {r.status.replace(/_/gu, " ")}
                                                            </span>
                                                        </span>
                                                        <span className="money">
                                                            <span className="stake">
                                                                {r.stakeEth} {r.currency === "tron" ? "TRON" : "ETH"}
                                                            </span>
                                                        </span>
                                                        <button onClick={() => openRoom(r.id)}>Resume</button>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="panel">
                                            <h2>History</h2>
                                            {history.length === 0 && <p className="muted small">No finished games yet.</p>}
                                            <ul className="history">
                                                {history.map((h) => (
                                                    <li key={h.id}>
                                                        <span>
                                                            <span className={`outcome ${h.outcome}`}>{h.outcome}</span>{" "}
                                                            <span style={{ marginLeft: 8 }}>
                                                                {h.gameId} · {h.stakeEth}{" "}
                                                                {h.currency === "tron" ? "TRON" : "ETH"} · vs{" "}
                                                                {h.opponent?.displayName ?? "—"}
                                                            </span>
                                                        </span>
                                                        <span className="muted small">
                                                            {new Date(h.finishedAt).toLocaleDateString()}
                                                        </span>
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    </>
                                )}
                            </div>
                        )}
                    </section>

                    {/* ── RIGHT — context ─────────────────────────────────── */}
                    <aside className="shell-context">
                        <div className="ctx-card">
                            <h4>At a glance</h4>
                            <div className="ctx-row">
                                <span className="k">Open matches</span>
                                <span className="v">{mine.length}</span>
                            </div>
                            <div className="ctx-row">
                                <span className="k">Joinable now</span>
                                <span className="v">{joinable.length}</span>
                            </div>
                            <div className="ctx-row">
                                <span className="k">Points</span>
                                <span className="v">◆ {user?.points ?? 0}</span>
                            </div>
                        </div>
                        <div className="ctx-card">
                            <h4>Elsewhere</h4>
                            <CtxLink to="/store" icon="🛒">
                                Store
                            </CtxLink>
                            <CtxLink to="/profile" icon="👤">
                                Profile & stats
                            </CtxLink>
                        </div>
                    </aside>
                </div>
            </main>
        </>
    );
}
