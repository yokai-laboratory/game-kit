import "dotenv/config";
import { z } from "zod";

// Single source of truth for runtime config. Every value is env-driven (12-factor) so the same
// image runs locally, on a VPS, or across replicas with only env differences. No secrets are
// baked into the build.

const schema = z.object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    API_PORT: z.coerce.number().default(8788),
    // Public origin of the web app -- used for CORS, OAuth redirect, and charge return URIs.
    WEB_ORIGIN: z.string().default("http://localhost:5274"),

    // Persistence: a single SQLite file on disk. Zero external dependencies -- the default
    // single-machine path connects to nothing but the file. For horizontal scale-out, move to a
    // shared Postgres + the Redis backplane below.
    SQLITE_PATH: z.string().default("./data/game-kit.sqlite"),

    // OPTIONAL scale-out switch. Unset (the default) -> in-process realtime backplane + tick lease,
    // and `ioredis` is never imported. Set it -> Redis-backed backplane + lease so the API tier can
    // run multiple replicas behind a load balancer (WebSocket fan-out + tick leasing go through
    // Redis). See realtime/hub.ts and game/ticker.ts for the swappable seams.
    REDIS_URL: z.string().optional(),

    SESSION_SECRET: z.string().min(16).default("dev-only-insecure-secret-change-me"),

    // OAuth client -- Metatron is the identity provider. Obtain these from the TRON developer
    // dashboard (the setup skill walks you through it). client_secret is server-only.
    OAUTH_PROVIDER_NAME: z.string().default("metatron"),
    OAUTH_AUTHORIZE_URL: z.string().url(),
    OAUTH_TOKEN_URL: z.string().url(),
    OAUTH_USERINFO_URL: z.string().url(),
    OAUTH_CLIENT_ID: z.string(),
    OAUTH_CLIENT_SECRET: z.string(),
    OAUTH_REDIRECT_URI: z.string().url(),
    // `payments:charge` is required so the API can debit users via TRON's app-initiated charge surface.
    OAUTH_SCOPES: z.string().default("openid profile payments:charge"),

    // Where TRON's API is reachable for server-to-server payment calls + the events socket.
    TRON_API_ORIGIN: z.string().url(),
    // Chain to charge against. Must be present in TRON's enabled-chains catalog.
    PAYMENT_CHAIN: z.string(),
    // Token address. 0x000…0 for native ETH, any other 20-byte address for an ERC-20.
    PAYMENT_TOKEN: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),

    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export const env = schema.parse({
    NODE_ENV: process.env.NODE_ENV,
    API_PORT: process.env.API_PORT,
    WEB_ORIGIN: process.env.WEB_ORIGIN,
    SQLITE_PATH: process.env.SQLITE_PATH,
    REDIS_URL: process.env.REDIS_URL,
    SESSION_SECRET: process.env.SESSION_SECRET,
    OAUTH_PROVIDER_NAME: process.env.OAUTH_PROVIDER_NAME,
    OAUTH_AUTHORIZE_URL: process.env.OAUTH_AUTHORIZE_URL,
    OAUTH_TOKEN_URL: process.env.OAUTH_TOKEN_URL,
    OAUTH_USERINFO_URL: process.env.OAUTH_USERINFO_URL,
    OAUTH_CLIENT_ID: process.env.OAUTH_CLIENT_ID,
    OAUTH_CLIENT_SECRET: process.env.OAUTH_CLIENT_SECRET,
    OAUTH_REDIRECT_URI: process.env.OAUTH_REDIRECT_URI,
    OAUTH_SCOPES: process.env.OAUTH_SCOPES,
    TRON_API_ORIGIN: process.env.TRON_API_ORIGIN,
    PAYMENT_CHAIN: process.env.PAYMENT_CHAIN,
    PAYMENT_TOKEN: process.env.PAYMENT_TOKEN,
    LOG_LEVEL: process.env.LOG_LEVEL,
});

export type Env = typeof env;
