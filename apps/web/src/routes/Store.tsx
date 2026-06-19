import { useCallback, useEffect, useState } from "react";
import { getPoints, type PointPack } from "../core/api";
import { useAuth } from "../core/auth";
import { usePurchase } from "../core/use-charge";

// The store: buy point packs with a one-way TRON charge. This is the inventory/soft-currency pattern
// — unlike a room stake there is no pot and no refund; the charge debits the player and the server
// credits points on completion. The buy buttons drive usePurchase(); on a silent (offline
// auto-charge) completion the points land immediately, so we refresh the session to update the
// balance. A charge that needs confirmation redirects to TRON and returns via /payment-return.
export function Store(): React.JSX.Element {
    const { user, refresh } = useAuth();
    const { status, purchase, reset } = usePurchase();
    const [packs, setPacks] = useState<PointPack[]>([]);
    const [pendingPack, setPendingPack] = useState<string | null>(null);

    const loadPacks = useCallback(async () => {
        const data = await getPoints();
        setPacks(data.packs);
    }, []);

    useEffect(() => {
        void loadPacks();
    }, [loadPacks]);

    // A silent completion credits points server-side; pull the new balance into the session.
    useEffect(() => {
        if (status.kind === "completed") {
            void refresh();
            setPendingPack(null);
        }
    }, [status.kind, refresh]);

    const onBuy = (packId: string) => {
        reset();
        setPendingPack(packId);
        void purchase(packId);
    };

    return (
        <main className="store">
            <section className="panel">
                <h2>Store</h2>
                <p className="muted">
                    Your balance: <strong className="points-inline">◆ {user?.points ?? 0}</strong>
                </p>
                <p className="muted small">
                    Points are bought with a one-way charge — a demo of selling in-game currency or inventory on
                    Metatron rails. Nothing here is staked or refundable.
                </p>
            </section>

            <section className="panel">
                <h2>Point packs</h2>
                <ul className="pack-list">
                    {packs.map((pack) => {
                        const busy = status.kind === "requesting" && pendingPack === pack.id;
                        return (
                            <li key={pack.id}>
                                <span>
                                    <strong>◆ {pack.points}</strong> · {pack.title}{" "}
                                    <span className="muted">{pack.priceEth} ETH</span>
                                </span>
                                <button
                                    disabled={status.kind === "requesting"}
                                    onClick={() => onBuy(pack.id)}
                                >
                                    {busy ? "Charging…" : "Buy"}
                                </button>
                            </li>
                        );
                    })}
                </ul>
                {status.kind === "completed" && <p className="muted small">Purchase complete — points added ✓</p>}
                {status.kind === "limit_exceeded" && (
                    <p className="error">
                        This purchase would exceed your monthly cap.{" "}
                        <a className="link" href={status.redirectUrl}>
                            Raise it on Metatron
                        </a>
                        .
                    </p>
                )}
                {status.kind === "error" && <p className="error">{status.message}</p>}
            </section>
        </main>
    );
}
