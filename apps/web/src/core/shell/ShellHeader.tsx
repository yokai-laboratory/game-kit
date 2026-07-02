import type { ReactNode } from "react";

// Coin Factory's ShellHeader: sticky, frosted, three-column grid — the title is LOCKED to the
// center in a glass pill while the left/right slots grow independently.
export function ShellHeader({
    title,
    left,
    right,
}: {
    title: string;
    left?: ReactNode;
    right?: ReactNode;
}): React.JSX.Element {
    return (
        <header className="shell-header">
            <div className="shell-header-inner">
                <div className="slot left">{left}</div>
                <h1 className="title">{title}</h1>
                <div className="slot right">{right}</div>
            </div>
        </header>
    );
}
