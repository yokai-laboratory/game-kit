import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { AuthProvider, useAuth } from "./core/auth";
import { ChromeProvider, useChrome } from "./core/shell/chrome";
import { BottomNav } from "./core/shell/BottomNav";
import { Landing } from "./routes/Landing";
import { Play } from "./routes/Play";
import { Profile } from "./routes/Profile";
import { Store } from "./routes/Store";
import { PaymentReturn } from "./routes/PaymentReturn";

export function App() {
    return (
        <AuthProvider>
            <ChromeProvider>
                <Shell />
            </ChromeProvider>
        </AuthProvider>
    );
}

// Rooms live inside the Play hub (?room=<id>); old /room/:id links land there.
function RoomRedirect() {
    const { id } = useParams<{ id: string }>();
    return <Navigate to={`/?room=${id ?? ""}`} replace />;
}

function Shell() {
    const { user, loading } = useAuth();
    const { immersive, booted } = useChrome();
    if (loading) {
        return (
            <div className="shell">
                <div className="empty">Loading…</div>
            </div>
        );
    }
    const gate = <Navigate to="/" replace />;
    return (
        // "booting": chrome (header/main/nav) is invisible while an engine splash plays on the
        // backdrop; it fades in together at the SHELL_BOOT_MS mark.
        <div className={`shell ${booted ? "booted" : "booting"}`}>
            <Routes>
                <Route path="/" element={user ? <Play /> : <Landing />} />
                <Route path="/store" element={user ? <Store /> : gate} />
                <Route path="/profile" element={user ? <Profile /> : gate} />
                <Route path="/room/:id" element={<RoomRedirect />} />
                <Route path="/payment-return" element={user ? <PaymentReturn /> : gate} />
                <Route path="/lobby" element={<Navigate to="/" replace />} />
                <Route path="*" element={gate} />
            </Routes>
            {user && !immersive && <BottomNav />}
        </div>
    );
}
