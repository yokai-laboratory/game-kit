import { getGameBackdrop } from "../../games/registry";

// The fullscreen game backdrop: the game owns the screen; the UI floats above it. A game may
// register a Backdrop component (games/registry.tsx) — typically an ENGINE running in attract
// mode (Unity, Godot, GameMaker, or a plain canvas; the shell doesn't care — a backdrop is just
// a component that fills its absolutely-positioned parent and animates). Without one, the shell
// renders the engine-free aurora so the pattern works before any engine exists.
//
// Engine adapters live in the GAME's folder, never in core — see docs/SHELL.md for the
// adopt/start/begin bridge contract they implement.
export function GameSurface({ dim = false, gameId }: { dim?: boolean; gameId?: string }): React.JSX.Element {
    const Backdrop = gameId ? getGameBackdrop(gameId) : undefined;
    return (
        <div className="game-surface" aria-hidden>
            <div className={dim ? "backdrop-blur" : undefined} style={{ position: "absolute", inset: dim ? undefined : 0 }}>
                {Backdrop ? <Backdrop /> : <AuroraBackdrop />}
            </div>
            <div className="scrim" style={dim ? { background: "rgba(2, 6, 23, 0.82)" } : undefined} />
            <div className="vignette" />
        </div>
    );
}

/** Ambient default: drifting gradient blobs. Zero engine, zero cost, on-theme. */
export function AuroraBackdrop(): React.JSX.Element {
    return (
        <div className="aurora">
            <span className="blob b1" />
            <span className="blob b2" />
            <span className="blob b3" />
        </div>
    );
}
