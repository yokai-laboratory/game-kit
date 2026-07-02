// ── Shell configuration — the ONE file a game edits to brand the chrome ─────
// The shell (bottom nav, header, boot sequence) reads this; nothing else in core is
// game-specific. Add tabs freely; the `primary` tab sits center with the glow treatment.

export interface ShellTab {
    to: string;
    label: string;
    icon: string;
    primary?: boolean;
    end?: boolean;
}

export const SHELL_BRAND = "game-kit";

export const SHELL_TABS: ShellTab[] = [
    { to: "/", label: "Play", icon: "🎮", primary: true, end: true },
    { to: "/store", label: "Store", icon: "🛒" },
    { to: "/profile", label: "Profile", icon: "👤" },
];

/** Milliseconds the chrome stays hidden after a page load, letting an engine splash play. */
export const SHELL_BOOT_MS = 1_200;
