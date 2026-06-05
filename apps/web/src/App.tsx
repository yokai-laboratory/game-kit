import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./core/auth";
import { TopBar } from "./core/TopBar";
import { Landing } from "./routes/Landing";
import { Lobby } from "./routes/Lobby";
import { Room } from "./routes/Room";
import { PaymentReturn } from "./routes/PaymentReturn";

export function App() {
    return (
        <AuthProvider>
            <Shell />
        </AuthProvider>
    );
}

function Shell() {
    const { user, loading } = useAuth();
    if (loading) {
        return (
            <div className="shell">
                <div className="empty">Loading…</div>
            </div>
        );
    }
    return (
        <div className="shell">
            <TopBar />
            <Routes>
                <Route path="/" element={user ? <Navigate to="/lobby" replace /> : <Landing />} />
                <Route path="/lobby" element={user ? <Lobby /> : <Navigate to="/" replace />} />
                <Route path="/room/:id" element={user ? <Room /> : <Navigate to="/" replace />} />
                <Route path="/payment-return" element={user ? <PaymentReturn /> : <Navigate to="/" replace />} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </div>
    );
}
