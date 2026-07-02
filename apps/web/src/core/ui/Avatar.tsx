// Platform avatar with initial fallback — used everywhere a player appears (headers, listings,
// frens). Keep listings social: a face, a name, and what's at stake.
export function Avatar({
    url,
    name,
    size = 34,
    presence = false,
}: {
    url?: string | null;
    name: string;
    size?: number;
    presence?: boolean;
}): React.JSX.Element {
    const dot = presence ? (
        <span
            className="presence"
            style={{
                position: "absolute",
                right: -1,
                bottom: -1,
                height: Math.max(8, size * 0.28),
                width: Math.max(8, size * 0.28),
                borderRadius: 999,
                border: "2px solid #020617",
                background: "var(--emerald)",
            }}
        />
    ) : null;
    if (url) {
        return (
            <span style={{ position: "relative", flexShrink: 0, display: "inline-flex" }}>
                <img
                    src={url}
                    alt=""
                    style={{
                        height: size,
                        width: size,
                        borderRadius: 999,
                        objectFit: "cover",
                        boxShadow: "0 0 0 2px rgba(255,255,255,0.12)",
                    }}
                />
                {dot}
            </span>
        );
    }
    return (
        <span
            className="avatar"
            style={{ position: "relative", height: size, width: size, fontSize: Math.round(size * 0.44) }}
        >
            {name.slice(0, 1).toUpperCase()}
            {dot}
        </span>
    );
}
