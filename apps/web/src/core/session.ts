// Client-side session token store. The api hands the opaque session id back in the OAuth callback's
// URL fragment (`#session=`); we persist it in localStorage and present it as a bearer token on REST
// + WS calls (see api.ts / config.ts). This replaces a session cookie, which the browser refuses to
// send on a cross-site request from the web to the api (third-party cookies are blocked regardless of
// SameSite) -- the case that arises when the game's frontend subdomain and its api are different
// hosts. Origin-agnostic: works the same in the same-origin (reverse-proxy) deploy.
const STORAGE_KEY = "gk_session";

export function getSessionToken(): string | null {
    try {
        return localStorage.getItem(STORAGE_KEY);
    } catch {
        return null;
    }
}

export function setSessionToken(token: string): void {
    try {
        localStorage.setItem(STORAGE_KEY, token);
    } catch {
        // Private-mode / storage-disabled: the session lives only for this page's lifetime.
    }
}

export function clearSessionToken(): void {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // ignore
    }
}

// Called once on app load. If the OAuth callback redirected us with `#session=<id>`, persist the
// token and strip the fragment from the URL (history.replaceState, so it never lands in history or a
// subsequent share/bookmark). Returns true if a token was captured.
export function captureSessionFromUrl(): boolean {
    const hash = window.location.hash;
    if (!hash || hash.length < 2) return false;
    const params = new URLSearchParams(hash.slice(1));
    const token = params.get("session");
    if (!token) return false;
    setSessionToken(token);
    params.delete("session");
    const rest = params.toString();
    const cleaned = `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ""}`;
    window.history.replaceState(null, "", cleaned);
    return true;
}
