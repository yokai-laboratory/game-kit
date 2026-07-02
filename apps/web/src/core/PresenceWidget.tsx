import { mountPresenceWidget } from "@metatrongg/sdk/browser";
import { useEffect, useRef } from "react";
import { getPresenceConfig } from "./api";

// Mounts TRON's origin-isolated active-play presence widget via the SDK. The widget is served by
// TRON's API and frames the TRON web widget where Privy runs in the player's own first-party TRON
// session -- this app's JS can neither read into it nor fabricate "active". The SDK surfaces the
// minted playSessionId, which we relay to our server so it can drive the game-half handshake.
export function PresenceWidget(props: {
    readonly onPlaySessionId: (playSessionId: string) => void;
    readonly onStatus?: (status: string) => void;
    // True once the widget confirms the player's first-party Metatron session; false means they
    // need to sign in at the platform in THIS browser before presence can activate.
    readonly onAuthChange?: (authenticated: boolean) => void;
}): React.JSX.Element {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const cbRef = useRef(props);
    cbRef.current = props;

    useEffect(() => {
        let handle: { destroy: () => void } | null = null;
        let cancelled = false;
        void getPresenceConfig()
            .then((cfg) => {
                if (cancelled || containerRef.current === null) return;
                handle = mountPresenceWidget({
                    apiOrigin: cfg.tronApiOrigin,
                    clientId: cfg.clientId,
                    container: containerRef.current,
                    // On-brand chip: rounded, faint primary border, glass-adjacent. (The SDK
                    // swaps to its own fullscreen style when the widget self-promotes to an
                    // overlay, and restores this after.)
                    styleIframe: (iframe) => {
                        iframe.style.border = "1px solid rgba(139, 125, 216, 0.35)";
                        iframe.style.borderRadius = "0.75rem";
                        iframe.style.boxShadow = "0 2px 12px rgba(139, 125, 216, 0.15)";
                        iframe.style.display = "block";
                        iframe.style.width = "190px";
                        iframe.style.height = "44px";
                        iframe.style.background = "rgba(2, 6, 23, 0.6)";
                    },
                    onPlaySessionId: (id) => {
                        if (id !== null) cbRef.current.onPlaySessionId(id);
                    },
                    onStatus: (status) => cbRef.current.onStatus?.(status),
                    onAuthChange: (authenticated) => cbRef.current.onAuthChange?.(authenticated),
                });
            })
            .catch(() => {
                // presence is best-effort; leave it unmounted on a config fetch failure.
            });
        return () => {
            cancelled = true;
            handle?.destroy();
        };
    }, []);

    return <div ref={containerRef} />;
}
