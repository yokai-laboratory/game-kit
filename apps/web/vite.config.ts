import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// In dev, Vite proxies /api + /ws to the API server so the browser talks to a single origin (no
// CORS). In a same-origin prod deploy the reverse proxy (Caddy) does the same routing. When the web
// is built for a separate origin (the platform's frontend subdomain pointing at the dev's own api),
// set VITE_API_ORIGIN at build time and the client calls that origin directly. Auth is a bearer
// token (apps/web/src/core/session.ts), not a cookie, so it works across origins without config.
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), "");
    const api = env.VITE_API_ORIGIN ?? "http://localhost:8788";
    // game-kit's web defaults to 5274 (and the api to 8788) so it coexists with the sibling games
    // on one machine — hilow owns 5273/8787. Override per-checkout via WEB_PORT if needed.
    const port = Number(env.WEB_PORT) || 5274;
    return {
        plugins: [react()],
        server: {
            port,
            proxy: {
                "/api": {
                    target: api,
                    changeOrigin: true,
                    rewrite: (path) => path.replace(/^\/api/, ""),
                },
                "/ws": {
                    target: api,
                    changeOrigin: true,
                    ws: true,
                },
            },
        },
    };
});
