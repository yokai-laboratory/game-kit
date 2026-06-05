import { pino } from "pino";
import { env } from "./env.js";

// Structured JSON logs to stdout -- `docker logs` / journald collect them. Pretty-printing is left
// to a dev-time pipe (`pnpm dev | pino-pretty`) so production stays plain JSON. The optional
// observability overlay (deploy/docker-compose.observability.yml) ships these to Loki via the OTel
// collector; nothing here depends on that being present.
export const logger = pino({
    level: env.LOG_LEVEL,
    base: { service: "game-kit-api" },
});

export type Logger = typeof logger;
