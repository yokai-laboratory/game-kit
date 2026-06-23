// Single source for where the api lives, for both deploy topologies the kit supports:
//
//  - Same-origin (the default Caddy / single-domain deploy): web + api under one host, api routed at
//    /api. VITE_API_ORIGIN is unset in the build, so API_BASE is "/api" and the WS is same-origin.
//  - Separate origins (the platform gives the game a frontend subdomain that points at the dev's own
//    api on another host): set VITE_API_ORIGIN at build time to the api origin; the client then calls
//    it directly (api routes are served at root there) and opens the WS against it.
//
// In dev everything is same-origin behind the Vite proxy (/api -> api with the prefix stripped, /ws
// upgraded), so we always use relative paths in dev regardless of VITE_API_ORIGIN (which doubles as
// the proxy target). Keying off import.meta.env.PROD keeps dev on the proxy.
import { getSessionToken } from "./session";

const ORIGIN = ((import.meta.env.VITE_API_ORIGIN as string | undefined) ?? "").replace(/\/$/, "");

// REST base. Dev: "/api" (proxy strips the prefix). Prod: the api origin when VITE_API_ORIGIN is set
// (separate-origin deploy, routes at root), else "/api" (same-origin reverse-proxy deploy).
export const API_BASE = import.meta.env.PROD ? ORIGIN || "/api" : "/api";

// WebSocket URL for an api path. Same-origin (dev proxy or Caddy): the current host with ws(s). When
// the api is on a separate origin: that origin with the ws(s) scheme (the WS can't go through a
// static frontend host). The session bearer can't ride a WebSocket Authorization header (the browser
// API forbids custom headers on `new WebSocket`), so it travels as `?token=` -- the api reads either
// source (see auth/session.ts).
export function wsUrl(path: string): string {
    const token = getSessionToken();
    const withToken = (origin: string): string =>
        token ? `${origin}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : `${origin}${path}`;
    if (import.meta.env.PROD && ORIGIN) {
        return withToken(ORIGIN.replace(/^http/, "ws"));
    }
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return withToken(`${proto}//${window.location.host}`);
}
