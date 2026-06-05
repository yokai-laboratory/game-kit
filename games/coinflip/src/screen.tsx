import type { GameScreenProps } from "@game-kit/game-core";
import { useEffect, useState } from "react";
import type { CoinflipMove, CoinflipView, Side } from "./schema.js";

// The coin-flip duel screen. Receives the redacted per-seat view + a submitMove callback from the
// generic Room component (apps/web/src/core). Everything game-specific lives in this one file +
// schema.ts + module.ts -- that's the whole "build your own game" surface.

const SIDES: readonly Side[] = ["heads", "tails"];

export function CoinflipScreen(props: GameScreenProps<CoinflipView, CoinflipMove>): React.JSX.Element {
    const { view, opponent, status, result, you, submitMove, lastEvent } = props;
    const [flash, setFlash] = useState<string | null>(null);

    // Surface the latest round_resolved event briefly so players see the flip.
    useEffect(() => {
        if (lastEvent?.kind !== "round_resolved") return;
        const flip = String(lastEvent.flip ?? "");
        setFlash(`Round ${String(lastEvent.round ?? "")}: ${flip.toUpperCase()}`);
        const t = setTimeout(() => setFlash(null), 2200);
        return () => clearTimeout(t);
    }, [lastEvent]);

    if (status !== "in_progress" && status !== "completed") {
        return <p className="muted">Waiting for both players to stake…</p>;
    }

    const opponentName = opponent?.displayName ?? "Opponent";
    const decided = view.phase === "complete";

    return (
        <div className="coinflip">
            <div className="scoreline">
                <span>
                    <strong>{you.displayName}</strong> {view.wins.you}
                </span>
                <span className="muted">
                    Round {Math.min(view.round, view.rounds)} / {view.rounds}
                </span>
                <span>
                    {view.wins.opponent} <strong>{opponentName}</strong>
                </span>
            </div>

            {flash && <div className="flash">{flash}</div>}

            {!decided && (
                <div className="picker">
                    <p className="muted">
                        {view.yourPick
                            ? view.opponentSubmitted
                                ? "Flipping…"
                                : `You picked ${view.yourPick.toUpperCase()} — waiting for ${opponentName}`
                            : "Pick a side (hidden until both choose)"}
                    </p>
                    <div className="pick-buttons">
                        {SIDES.map((s) => (
                            <button
                                key={s}
                                disabled={view.yourPick !== null}
                                className={view.yourPick === s ? "pick selected" : "pick"}
                                onClick={() => submitMove({ pick: s })}
                            >
                                {s === "heads" ? "🪙 Heads" : "👑 Tails"}
                            </button>
                        ))}
                    </div>
                    {view.opponentSubmitted && view.yourPick === null && (
                        <p className="muted">{opponentName} has locked in — your move.</p>
                    )}
                </div>
            )}

            {decided && (
                <div className="result">
                    {result.kind === "win" && (
                        <h3>{result.winnerUserId === you.id ? "🎉 You won the pot!" : "You lost this one."}</h3>
                    )}
                    {result.kind === "draw" && <h3>Draw — stakes refunded.</h3>}
                </div>
            )}

            {view.history.length > 0 && (
                <ol className="rounds">
                    {view.history.map((r) => (
                        <li key={r.round}>
                            R{r.round}: flip <strong>{r.flip}</strong> · you{" "}
                            {(props.seat === "host" ? r.picks.host : r.picks.guest).toUpperCase()} · {opponentName}{" "}
                            {(props.seat === "host" ? r.picks.guest : r.picks.host).toUpperCase()} —{" "}
                            {r.winner === null ? "push" : r.winner === props.seat ? "won" : "lost"}
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
}

export default CoinflipScreen;
