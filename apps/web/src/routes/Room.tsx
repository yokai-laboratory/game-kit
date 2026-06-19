import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getPreflight, type Preflight } from "../core/api";
import { useCharge } from "../core/use-charge";
import { useRoomSocket } from "../core/ws";
import { PresenceWidget } from "../core/PresenceWidget";
import { getGameScreen } from "../games/registry";

function usd(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
}

export function Room(): React.JSX.Element {
    const { id } = useParams<{ id: string }>();
    const { view, error, submitMove, submitInput, lastEvent, relayPresence, presenceActive } = useRoomSocket(
        id ?? null,
    );
    const { status: chargeStatus, charge } = useCharge();
    const [preflight, setPreflight] = useState<Preflight | null>(null);

    const status = view?.room.status;
    const seat = view?.seat;
    const youOweStake =
        (status === "awaiting_host_stake" && seat === "host") ||
        (status === "awaiting_guest_stake" && seat === "guest");

    useEffect(() => {
        if (!id || !youOweStake) return;
        void getPreflight(id)
            .then(setPreflight)
            .catch(() => setPreflight(null));
    }, [id, youOweStake]);

    if (!id) return <main className="room">Bad room.</main>;
    if (!view) return <main className="room"><p className="empty">Connecting…</p></main>;

    const Screen = getGameScreen(view.game.id);

    return (
        <main className="room">
            <div className="room-head">
                <h2>
                    {view.game.id} · {view.room.stakeEth} ETH
                </h2>
                <span className="muted">
                    {view.you.displayName} vs {view.opponent?.displayName ?? "…"}
                </span>
            </div>

            {error && <p className="error">socket: {error}</p>}

            {/* Stake phase ------------------------------------------------------ */}
            {youOweStake && (
                <section className="panel stake">
                    <h3>Stake to play</h3>
                    {preflight && (
                        <p className="muted">
                            {view.room.stakeEth} ETH ≈ {usd(preflight.stake.usdCents)} ·{" "}
                            {preflight.derived.willChargeInstantly
                                ? "will charge instantly"
                                : "you'll confirm on Metatron"}
                        </p>
                    )}
                    {preflight?.derived.willExceedCap && (
                        <p className="error">This stake would exceed your monthly cap — raise it on the confirm page.</p>
                    )}
                    {/* Mount the presence widget so an offline-eligible charge can fire silently. */}
                    <PresenceWidget onPlaySessionId={relayPresence} />
                    <p className="muted small">presence: {presenceActive ? "active ✓" : "…"}</p>

                    {chargeStatus.kind === "limit_exceeded" ? (
                        <a className="cta" href={chargeStatus.redirectUrl}>
                            Raise cap &amp; pay
                        </a>
                    ) : (
                        <button
                            className="cta"
                            disabled={chargeStatus.kind === "requesting" || chargeStatus.kind === "redirecting"}
                            onClick={() => void charge(id)}
                        >
                            {chargeStatus.kind === "requesting" ? "Charging…" : "Stake & play"}
                        </button>
                    )}
                    {chargeStatus.kind === "error" && <p className="error">{chargeStatus.message}</p>}
                </section>
            )}

            {/* Waiting on the other player ------------------------------------- */}
            {!youOweStake && (status === "awaiting_host_stake" || status === "awaiting_guest_stake") && (
                <p className="muted">Waiting for your opponent to stake…</p>
            )}
            {status === "waiting" && <p className="muted">Waiting for an opponent to join…</p>}

            {/* The game ------------------------------------------------------- */}
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
        </main>
    );
}
