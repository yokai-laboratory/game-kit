/* eslint-disable no-console */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

// ─────────────────────────────────────────────────────────────────────────────
// game-kit setup -- wires the Titanium Games OAuth client + writes env files.
//
// Two paths (prefers API, falls back to guided paste):
//   • API-driven: set TTG_DEV_TOKEN (a TTG developer access token) and this creates/uses an app via
//     the TTG developer API, sets the redirect URI, and rotates a key automatically.
//   • Guided: otherwise it discovers the OAuth endpoints and prompts you to paste the client_id /
//     client_secret from the TTG developer dashboard.
//
// Every prompt can be pre-answered with an env var so an agent can run it non-interactively, e.g.:
//   TTG_API_ORIGIN=https://api.ttg.example DOMAIN=play.mygame.com \
//   OAUTH_CLIENT_ID=... OAUTH_CLIENT_SECRET=... pnpm setup
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rl = createInterface({ input: stdin, output: stdout });

function isTTY(): boolean {
    return Boolean(stdin.isTTY);
}

async function ask(label: string, envKey: string, fallback?: string): Promise<string> {
    const fromEnv = process.env[envKey];
    if (fromEnv && fromEnv.length > 0) {
        console.log(`  ${envKey} = ${redact(envKey, fromEnv)} (from env)`);
        return fromEnv;
    }
    if (!isTTY()) {
        if (fallback !== undefined) return fallback;
        throw new Error(`Missing ${envKey} and no TTY to prompt. Set it as an env var.`);
    }
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    return answer.length > 0 ? answer : (fallback ?? "");
}

function redact(key: string, value: string): string {
    return /secret|token|password/i.test(key) ? `${value.slice(0, 4)}…(${value.length} chars)` : value;
}

// Discover OAuth endpoints from the OIDC well-known doc, falling back to TTG's conventional paths.
async function discoverEndpoints(origin: string): Promise<{ authorize: string; token: string; userinfo: string }> {
    const base = new URL(origin).origin;
    try {
        const res = await fetch(`${base}/.well-known/openid-configuration`);
        if (res.ok) {
            const doc = (await res.json()) as {
                authorization_endpoint?: string;
                token_endpoint?: string;
                userinfo_endpoint?: string;
            };
            if (doc.authorization_endpoint && doc.token_endpoint && doc.userinfo_endpoint) {
                console.log("  discovered OAuth endpoints via /.well-known/openid-configuration");
                return { authorize: doc.authorization_endpoint, token: doc.token_endpoint, userinfo: doc.userinfo_endpoint };
            }
        }
    } catch {
        // fall through to conventional paths
    }
    console.log("  using conventional /oauth/* endpoints (well-known not available)");
    return {
        authorize: `${base}/oauth/authorize`,
        token: `${base}/oauth/token`,
        userinfo: `${base}/oauth/userinfo`,
    };
}

// Best-effort API-driven app provisioning. The exact request/response shape may differ across TTG
// API versions; on any mismatch we throw and the caller falls back to guided paste.
async function provisionAppViaApi(input: {
    origin: string;
    token: string;
    name: string;
    redirectUri: string;
    environment: "development" | "production";
}): Promise<{ clientId: string; clientSecret: string }> {
    const base = new URL(input.origin).origin;
    const headers = { authorization: `Bearer ${input.token}`, "content-type": "application/json" };

    const createRes = await fetch(`${base}/me/developer/apps`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            name: input.name,
            environment: input.environment,
            redirectUris: [input.redirectUri],
        }),
    });
    if (!createRes.ok) throw new Error(`create app failed: ${createRes.status} ${await createRes.text()}`);
    const app = (await createRes.json()) as { id?: string; clientId?: string; client_id?: string };
    const appId = app.id;
    const clientId = app.clientId ?? app.client_id;
    if (!appId || !clientId) throw new Error("create app response missing id/clientId");

    const keyRes = await fetch(`${base}/me/developer/apps/${appId}/keys/${input.environment}`, {
        method: "PUT",
        headers,
    });
    if (!keyRes.ok) throw new Error(`rotate key failed: ${keyRes.status} ${await keyRes.text()}`);
    const key = (await keyRes.json()) as { clientSecret?: string; secret?: string };
    const clientSecret = key.clientSecret ?? key.secret;
    if (!clientSecret) throw new Error("rotate key response missing secret");

    console.log(`  created TTG app ${appId} and rotated a ${input.environment} key`);
    return { clientId, clientSecret };
}

function renderEnv(vars: Record<string, string>): string {
    return Object.entries(vars)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") + "\n";
}

function writeIfAbsentOrConfirmed(path: string, content: string, force: boolean): void {
    if (existsSync(path) && !force) {
        console.log(`  ! ${path} exists — not overwriting (set GAMEKIT_FORCE=1 to replace). Wrote nothing.`);
        return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`  ✓ wrote ${path}`);
}

async function main(): Promise<void> {
    console.log("\ngame-kit setup\n");

    const ttgOrigin = await ask("Titanium Games API origin (TTG_API_ORIGIN)", "TTG_API_ORIGIN");
    const domain = await ask("Public domain for production (DOMAIN), or 'localhost'", "DOMAIN", "localhost");
    const env = (await ask("Environment (development/production)", "GAMEKIT_ENV", "development")) as
        | "development"
        | "production";
    const provider = process.env.OAUTH_PROVIDER_NAME ?? "titanium-games";
    const paymentChain = await ask("Payment chain (PAYMENT_CHAIN)", "PAYMENT_CHAIN", "ethereum-sepolia");
    const paymentToken = await ask(
        "Payment token address (PAYMENT_TOKEN)",
        "PAYMENT_TOKEN",
        "0x0000000000000000000000000000000000000000",
    );

    const endpoints = await discoverEndpoints(ttgOrigin);

    // Redirect URI: prod goes through Caddy under /api; local dev hits the api directly.
    const isProd = env === "production" && domain !== "localhost";
    const redirectUri = isProd
        ? `https://${domain}/api/auth/callback`
        : "http://localhost:8787/auth/callback";
    const webOrigin = isProd ? `https://${domain}` : "http://localhost:5273";

    // Credentials: API-driven if a dev token is available, else guided paste.
    let clientId: string;
    let clientSecret: string;
    const devToken = process.env.TTG_DEV_TOKEN;
    if (devToken) {
        try {
            console.log("\nProvisioning app via TTG developer API…");
            const result = await provisionAppViaApi({
                origin: ttgOrigin,
                token: devToken,
                name: process.env.GAMEKIT_APP_NAME ?? "game-kit",
                redirectUri,
                environment: env,
            });
            clientId = result.clientId;
            clientSecret = result.clientSecret;
        } catch (e) {
            console.log(`  ! API provisioning failed (${(e as Error).message}). Falling back to paste.`);
            clientId = await ask("OAUTH_CLIENT_ID (from TTG dashboard)", "OAUTH_CLIENT_ID");
            clientSecret = await ask("OAUTH_CLIENT_SECRET (from TTG dashboard)", "OAUTH_CLIENT_SECRET");
        }
    } else {
        console.log("\nNo TTG_DEV_TOKEN set — guided setup.");
        console.log("In the TTG developer dashboard: create an app, set its redirect URI to:");
        console.log(`    ${redirectUri}`);
        console.log("then generate a key and paste the values below.\n");
        clientId = await ask("OAUTH_CLIENT_ID", "OAUTH_CLIENT_ID");
        clientSecret = await ask("OAUTH_CLIENT_SECRET", "OAUTH_CLIENT_SECRET");
    }

    const sessionSecret = process.env.SESSION_SECRET ?? randomBytes(32).toString("hex");
    const force = process.env.GAMEKIT_FORCE === "1";

    const common = {
        OAUTH_PROVIDER_NAME: provider,
        OAUTH_AUTHORIZE_URL: endpoints.authorize,
        OAUTH_TOKEN_URL: endpoints.token,
        OAUTH_USERINFO_URL: endpoints.userinfo,
        OAUTH_CLIENT_ID: clientId,
        OAUTH_CLIENT_SECRET: clientSecret,
        OAUTH_REDIRECT_URI: redirectUri,
        OAUTH_SCOPES: process.env.OAUTH_SCOPES ?? "openid profile payments:charge",
        TTG_API_ORIGIN: new URL(ttgOrigin).origin,
        PAYMENT_CHAIN: paymentChain,
        PAYMENT_TOKEN: paymentToken,
        SESSION_SECRET: sessionSecret,
        WEB_ORIGIN: webOrigin,
    };

    console.log("\nWriting env files…");

    // apps/api/.env for local dev (host-run api).
    writeIfAbsentOrConfirmed(
        join(ROOT, "apps/api/.env"),
        renderEnv({
            NODE_ENV: "development",
            API_PORT: "8787",
            DATABASE_URL: "postgres://gamekit:gamekit@localhost:5432/gamekit",
            REDIS_URL: "redis://localhost:6379",
            LOG_LEVEL: "info",
            ...common,
        }),
        force,
    );

    // deploy/.env for the docker stack (service-name hosts).
    const pgPass = process.env.POSTGRES_PASSWORD ?? randomBytes(12).toString("hex");
    writeIfAbsentOrConfirmed(
        join(ROOT, "deploy/.env"),
        renderEnv({
            NODE_ENV: "production",
            DOMAIN: domain,
            ACME_EMAIL: process.env.ACME_EMAIL ?? "",
            POSTGRES_USER: "gamekit",
            POSTGRES_PASSWORD: pgPass,
            POSTGRES_DB: "gamekit",
            DATABASE_URL: `postgres://gamekit:${pgPass}@postgres:5432/gamekit`,
            REDIS_URL: "redis://redis:6379",
            NPM_CONFIG_REGISTRY: process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org/",
            LOG_LEVEL: "info",
            ...common,
        }),
        force,
    );

    console.log("\nDone. Next:");
    console.log("  • local dev:  ./scripts/dev.sh");
    console.log("  • deploy:     cd deploy && docker compose --env-file .env up -d --build");
    console.log(`  • make sure ${redirectUri} is registered as a redirect URI on your TTG app.\n`);

    rl.close();
}

main().catch((err: unknown) => {
    console.error(`\nsetup failed: ${(err as Error).message}`);
    rl.close();
    process.exitCode = 1;
});
