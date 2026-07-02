import { API_BASE } from "../core/config";
import { GameSurface } from "../core/shell/GameSurface";

// Signed-out gate: the game's backdrop plays full screen behind the shimmering hero and the
// glowing sign-in CTA (the shell's press-to-play pattern).
export function Landing(): React.JSX.Element {
    return (
        <>
            <GameSurface />
            <main className="overlay">
                <div className="hero">
                    <h1>game-kit</h1>
                    <p>
                        A full-stack web3 game template on the Metatron rails — identity, stakes, pots, and presence
                        already wired. Sign in, play the demo, then swap in your own game.
                    </p>
                    <div className="glow-wrap">
                        {/* Top-level navigation to the api's /auth/login. API_BASE is "/api" same-origin or the
                            api origin when the web is on a separate host — works in both deploys. */}
                        <a className="cta" href={`${API_BASE}/auth/login`} style={{ position: "relative" }}>
                            ▶ Sign in with Metatron
                        </a>
                    </div>
                </div>
            </main>
        </>
    );
}
