import { API_BASE } from "../core/config";

export function Landing(): React.JSX.Element {
    return (
        <main className="landing">
            <h1>game-kit</h1>
            <p className="muted">
                A full-stack web3 game template on the Metatron rails. Sign in with your TRON account to play the
                example coin-flip duel — then swap it for your own game.
            </p>
            {/* Top-level navigation to the api's /auth/login. API_BASE is "/api" same-origin or the
                api origin when the web is on a separate host -- so the link works in both deploys. */}
            <a className="cta" href={`${API_BASE}/auth/login`}>
                Sign in with Metatron
            </a>
        </main>
    );
}
