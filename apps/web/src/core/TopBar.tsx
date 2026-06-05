import { Link } from "react-router-dom";
import { useAuth } from "./auth";

export function TopBar(): React.JSX.Element {
    const { user, logout } = useAuth();
    return (
        <header className="topbar">
            <Link to={user ? "/lobby" : "/"} className="brand">
                game-kit
            </Link>
            {user && (
                <div className="topbar-right">
                    <span className="muted">{user.displayName}</span>
                    <button className="link" onClick={() => void logout()}>
                        Sign out
                    </button>
                </div>
            )}
        </header>
    );
}
