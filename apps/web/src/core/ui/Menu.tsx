import type { ReactNode } from "react";
import { Link } from "react-router-dom";

// Shared three-column-shell primitives (Coin Factory's left-menu buttons + right-rail links),
// used by the Profile and Play pages.

export function MenuButton({
    icon,
    label,
    hint,
    active,
    onClick,
}: {
    icon: string;
    label: string;
    hint?: string;
    active?: boolean;
    onClick?: () => void;
}): React.JSX.Element {
    return (
        <button className={`menu-btn${active ? " active" : ""}`} onClick={onClick}>
            <span className="icon-box">{icon}</span>
            <span className="text">
                <span className="label">{label}</span>
                {hint && <span className="hint">{hint}</span>}
            </span>
            <span className="chev">›</span>
        </button>
    );
}

export function CtxLink({ to, icon, children }: { to: string; icon: string; children: ReactNode }): React.JSX.Element {
    return (
        <Link to={to} className="ctx-link">
            <span className="icon-box" style={{ height: 30, width: 30, fontSize: 14 }}>
                {icon}
            </span>
            {children}
        </Link>
    );
}
