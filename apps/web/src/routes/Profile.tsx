import { useCallback, useEffect, useState } from "react";
import type { GameHistoryItem } from "@game-kit/game-core";
import { fetchTronBalance, listHistory, type TronBalance } from "../core/api";
import { useAuth } from "../core/auth";
import { GameSurface } from "../core/shell/GameSurface";
import { ShellHeader } from "../core/shell/ShellHeader";
import { Avatar } from "../core/ui/Avatar";
import { CtxLink, MenuButton } from "../core/ui/Menu";

// Profile on the shell's three-column pattern: menu left, identity + active tab centre, account
// context right.

type Tab = "stats" | "activity";

export function Profile(): React.JSX.Element {
    const { user, logout } = useAuth();
    const [tab, setTab] = useState<Tab>("stats");
    const [history, setHistory] = useState<GameHistoryItem[]>([]);
    const [tron, setTron] = useState<TronBalance | null>(null);

    const load = useCallback(async () => {
        const [h, tb] = await Promise.all([listHistory(50), fetchTronBalance().catch(() => null)]);
        setHistory(h);
        setTron(tb);
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const wins = history.filter((h) => h.outcome === "win").length;
    const losses = history.filter((h) => h.outcome === "loss").length;
    const draws = history.filter((h) => h.outcome === "draw").length;
    const winRate = history.length > 0 ? Math.round((wins / history.length) * 100) : null;

    return (
        <>
            <GameSurface dim />
            <ShellHeader title="Profile" right={<span className="chip">◆ {user?.points ?? 0}</span>} />
            <main className="overlay" style={{ position: "relative", zIndex: 10 }}>
                <div className="shell-columns">
                    <div className="divider left" aria-hidden />
                    <div className="divider right" aria-hidden />

                    <aside className="shell-menu">
                        <div className="menu-group">
                            <p className="group-label">Profile</p>
                            <MenuButton
                                icon="📊"
                                label="Stats"
                                hint="Wins, form"
                                active={tab === "stats"}
                                onClick={() => setTab("stats")}
                            />
                            <MenuButton
                                icon="🕘"
                                label="Activity"
                                hint="Recent matches"
                                active={tab === "activity"}
                                onClick={() => setTab("activity")}
                            />
                        </div>
                        <button className="signout-btn" onClick={() => void logout()}>
                            ⏻ Sign out
                        </button>
                    </aside>

                    <section className="shell-content">
                        <div className="panel" style={{ marginBottom: 16 }}>
                            <div className="welcome" style={{ margin: 0 }}>
                                <Avatar url={user?.avatarUrl} name={user?.displayName ?? "?"} size={72} presence />
                                <div>
                                    <div className="name" style={{ fontSize: 22 }}>
                                        {user?.displayName}
                                    </div>
                                    <div className="greet">Signed in with Metatron · Test mode</div>
                                </div>
                            </div>
                        </div>

                        <div className="swap" key={tab}>
                            {tab === "stats" && (
                                <div className="panel">
                                    <h2>Stats</h2>
                                    <div className="stat-grid" style={{ marginTop: 14 }}>
                                        <div className="stat-tile">
                                            <div className="value">{history.length}</div>
                                            <div className="label">Matches</div>
                                        </div>
                                        <div className="stat-tile">
                                            <div className="value">{wins}</div>
                                            <div className="label">Wins</div>
                                        </div>
                                        <div className="stat-tile">
                                            <div className="value">{losses}</div>
                                            <div className="label">Losses</div>
                                        </div>
                                        <div className="stat-tile">
                                            <div className="value">{draws}</div>
                                            <div className="label">Draws</div>
                                        </div>
                                        <div className="stat-tile">
                                            <div className="value">{winRate === null ? "—" : `${winRate}%`}</div>
                                            <div className="label">Win rate</div>
                                        </div>
                                        <div className="stat-tile">
                                            <div className="value">◆ {user?.points ?? 0}</div>
                                            <div className="label">Points</div>
                                        </div>
                                    </div>
                                </div>
                            )}
                            {tab === "activity" && (
                                <div className="panel">
                                    <h2>Activity</h2>
                                    {history.length === 0 && <p className="muted small">No finished matches yet.</p>}
                                    <ul className="history">
                                        {history.map((h) => (
                                            <li key={h.id}>
                                                <span>
                                                    <span className={`outcome ${h.outcome}`}>{h.outcome}</span>{" "}
                                                    <span style={{ marginLeft: 8 }}>
                                                        {h.gameId} · {h.stakeEth} {h.currency === "tron" ? "TRON" : "ETH"} ·
                                                        vs {h.opponent?.displayName ?? "—"}
                                                    </span>
                                                </span>
                                                <span className="muted small">
                                                    {new Date(h.finishedAt).toLocaleDateString()}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    </section>

                    <aside className="shell-context">
                        <div className="ctx-card">
                            <h4>Account</h4>
                            <div className="ctx-row">
                                <span className="k">Display name</span>
                                <span className="v">{user?.displayName}</span>
                            </div>
                            <div className="ctx-row">
                                <span className="k">TRON balance</span>
                                <span className="v">
                                    {tron?.balanceCents == null ? "—" : `${tron.balanceCents.toLocaleString()} TRON`}
                                </span>
                            </div>
                            <div className="ctx-row">
                                <span className="k">Points</span>
                                <span className="v">◆ {user?.points ?? 0}</span>
                            </div>
                            <div className="ctx-row">
                                <span className="k">Environment</span>
                                <span className="v">Test mode</span>
                            </div>
                        </div>
                        <div className="ctx-card">
                            <h4>Jump back in</h4>
                            <CtxLink to="/" icon="🎮">
                                Play
                            </CtxLink>
                            <CtxLink to="/store" icon="🛒">
                                Store
                            </CtxLink>
                        </div>
                    </aside>
                </div>
            </main>
        </>
    );
}
