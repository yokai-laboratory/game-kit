import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../core/auth";
import { syncIntent } from "../core/use-charge";

// Landing page after TRON's /pay redirect flow. The events socket + poll backstop are the primary path
// to "intent completed"; this page just nudges TRON once (if we know the intent id) and bounces the
// user back to where they were — their room for a stake, the store for a purchase.
export function PaymentReturn(): React.JSX.Element {
    const [params] = useSearchParams();
    const navigate = useNavigate();
    const { refresh } = useAuth();
    const [msg, setMsg] = useState("Finishing up…");
    const roomId = params.get("roomId");
    const intentId = params.get("intentId");
    const isStore = params.get("store") === "1";

    useEffect(() => {
        let active = true;
        const go = async () => {
            if (intentId) {
                try {
                    await syncIntent(intentId);
                } catch {
                    // best-effort; the socket/backstop will reconcile.
                }
            }
            if (!active) return;
            if (roomId) {
                setMsg("Returning to your room…");
                setTimeout(() => navigate(`/?room=${roomId}`), 600);
            } else if (isStore) {
                // A purchase just settled; pull the new balance before landing back on the store.
                await refresh();
                navigate("/store");
            } else {
                navigate("/");
            }
        };
        void go();
        return () => {
            active = false;
        };
    }, [intentId, roomId, isStore, navigate, refresh]);

    return (
        <main className="room">
            <p className="empty">{msg}</p>
        </main>
    );
}
