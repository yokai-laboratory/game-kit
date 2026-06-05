import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// In dev, Vite proxies /api + /ws to the API server so the browser talks to a single origin (no
// CORS, cookies "just work"). In production the reverse proxy (Caddy) does the same routing, so the
// app code only ever calls relative /api and /ws paths regardless of environment.
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), "");
    const api = env.VITE_API_ORIGIN ?? "http://localhost:8787";
    return {
        plugins: [react()],
        server: {
            port: 5273,
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
