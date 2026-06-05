import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { syncIntent } from "../core/use-charge";

// Landing page after TTG's /pay redirect flow. The room socket + poll backstop are the primary path
// to "stake completed"; this page just nudges TTG once (if we know the intent id) and bounces the
// user back into their room.
export function PaymentReturn(): React.JSX.Element {
    const [params] = useSearchParams();
    const navigate = useNavigate();
    const [msg, setMsg] = useState("Finishing up…");
    const roomId = params.get("roomId");
    const intentId = params.get("intentId");

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
                setTimeout(() => navigate(`/room/${roomId}`), 600);
            } else {
                navigate("/lobby");
            }
        };
        void go();
        return () => {
            active = false;
        };
    }, [intentId, roomId, navigate]);

    return (
        <main className="room">
            <p className="empty">{msg}</p>
        </main>
    );
}
