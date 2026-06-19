import { mountPresenceWidget } from "@metatron/sdk/browser";
import { useEffect, useRef } from "react";
import { getPresenceConfig } from "./api";

// Mounts TRON's origin-isolated active-play presence widget via the SDK. The widget is served by
// TRON's API and frames the TRON web widget where Privy runs in the player's own first-party TRON
// session -- this app's JS can neither read into it nor fabricate "active". The SDK surfaces the
// minted playSessionId, which we relay to our server so it can drive the game-half handshake.
export function PresenceWidget(props: {
    readonly onPlaySessionId: (playSessionId: string) => void;
    readonly onStatus?: (status: string) => void;
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
                    onPlaySessionId: (id) => {
                        if (id !== null) cbRef.current.onPlaySessionId(id);
                    },
                    onStatus: (status) => cbRef.current.onStatus?.(status),
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
