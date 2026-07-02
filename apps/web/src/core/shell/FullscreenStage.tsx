import { useEffect, useState, type ReactNode } from "react";

// The fullscreen play stage: the page cross-fades away beneath it (see chrome.tsx immersive
// mode), the stage arrives showing the game ARMED but paused, waits for a tap, runs a 3·2·1
// countdown, and only then flips `begin` — the moment the game's clock should start.
//
//   fade-in (0.65s) → "tap to start" → 3 · 2 · 1 → begin
//
// Engine-agnostic on purpose: `children(begin)` renders WHATEVER plays the game — a Unity/Godot/
// GameMaker canvas adopted via the game's own adapter, or a plain React canvas. The only contract
// is that the child holds its opening frame while `begin` is false. Games without a pause-capable
// client can ignore `begin` and simply not use the stage.

type Phase = "ready" | "countdown" | "playing";

export function FullscreenStage({
    stageKey,
    children,
    hud,
    exitLabel,
    exitConfirm,
    onExit,
    prompt,
}: {
    /** Reset the gate when this changes (e.g. `${roomId}:${round}`). */
    stageKey: string;
    children: (begin: boolean) => ReactNode;
    /** Extra chips for the top-right HUD. */
    hud?: ReactNode;
    exitLabel: string;
    exitConfirm: string;
    onExit: () => void;
    /** One-liner under "Tap to start" (what this run is for). */
    prompt?: string;
}): React.JSX.Element {
    const [phase, setPhase] = useState<Phase>("ready");
    const [count, setCount] = useState(3);

    useEffect(() => {
        setPhase("ready");
        setCount(3);
    }, [stageKey]);

    useEffect(() => {
        if (phase !== "countdown") return;
        if (count === 0) {
            setPhase("playing");
            return;
        }
        const t = setTimeout(() => setCount((c) => c - 1), 550);
        return () => clearTimeout(t);
    }, [phase, count]);

    const arm = (): void => {
        if (phase === "ready") setPhase("countdown");
    };

    return (
        <div className="fullscreen-round round-enter">
            {children(phase === "playing")}

            {phase !== "playing" && (
                <button
                    type="button"
                    className="round-gate"
                    onClick={arm}
                    onKeyDown={(e) => {
                        if (e.code === "Space" || e.code === "Enter") arm();
                    }}
                >
                    {phase === "ready" && (
                        <span className="gate-inner">
                            <span className="gate-title">Tap to start</span>
                            {prompt && <span className="gate-sub">{prompt}</span>}
                        </span>
                    )}
                    {phase === "countdown" && (
                        <span className="gate-count" key={count}>
                            {count === 0 ? "GO" : count}
                        </span>
                    )}
                </button>
            )}

            <button
                className="exit-chip"
                onClick={() => {
                    if (window.confirm(exitConfirm)) onExit();
                }}
            >
                ✕ {exitLabel}
            </button>
            {hud && <div className="round-hud">{hud}</div>}
        </div>
    );
}
