import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { SHELL_BOOT_MS } from "../../shell.config";

// Coin Factory's ShellChrome pattern: pages can flip the shell into immersive mode (full-screen
// gameplay) and the chrome — the floating bottom nav — dissolves until they flip it back.
interface ChromeValue {
    immersive: boolean;
    setImmersive: (on: boolean) => void;
    /** False for SHELL_BOOT_MS after a page load — an engine splash can play on the backdrop
     *  uncontested, then the UI fades in over it. */
    booted: boolean;
}

const ChromeContext = createContext<ChromeValue | null>(null);


export function ChromeProvider({ children }: { children: ReactNode }): React.JSX.Element {
    const [immersive, setImmersive] = useState(false);
    const [booted, setBooted] = useState(false);

    useEffect(() => {
        const t = setTimeout(() => setBooted(true), SHELL_BOOT_MS);
        return () => clearTimeout(t);
    }, []);

    // Lock the root scroller while a round owns the screen. Without this the dissolve transform
    // (scale 1.04) and the shell's nav padding leave the document scrollable behind the fixed
    // round — which shows up as the gradient-styled scrollbars flashing in at the edges.
    useEffect(() => {
        if (!immersive) return;
        const html = document.documentElement.style;
        const body = document.body.style;
        const prev = { html: html.overflow, body: body.overflow };
        html.overflow = "hidden";
        body.overflow = "hidden";
        return () => {
            html.overflow = prev.html;
            body.overflow = prev.body;
        };
    }, [immersive]);

    const value = useMemo(() => ({ immersive, setImmersive, booted }), [immersive, booted]);
    return <ChromeContext.Provider value={value}>{children}</ChromeContext.Provider>;
}

export function useChrome(): ChromeValue {
    const ctx = useContext(ChromeContext);
    if (!ctx) throw new Error("useChrome outside ChromeProvider");
    return ctx;
}
