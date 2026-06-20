/* eslint-disable no-console */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

// ─────────────────────────────────────────────────────────────────────────────
// game-kit setup -- provisions the Metatron OAuth app + writes env files.
//
// game-kit is an EXTERNAL consumer of Metatron: it talks to Metatron only through Metatron's public
// developer surface (the MCP / developer dashboard / the developer REST API under /me/developer/*),
// never its source or database.
//
// One-time browser bootstrap (cannot be automated -- Metatron makes these session-only so a key can
// never mint another key or accept a policy on your behalf):
//   1. Sign in at the Metatron web app (local dev: http://localhost:5173).
//   2. Become a developer (accept the developer policy) -- POST /me/developer/request.
//   3. Mint a developer API key (a `tron_dev_…` token) in the dashboard.
// Then this script does the rest. Two paths (prefers API, falls back to guided paste):
//   • API-driven: set TRON_DEV_TOKEN to that `tron_dev_…` key. This creates an app, sets its redirect
//     URI + embed origin, mints a client key, and verifies a payout address exists for PAYMENT_CHAIN.
//     The payout address is your own Privy embedded wallet -- Metatron auto-seeds it when the app is
//     created, so payments:charge is grantable without you pasting an address.
//   • Guided: otherwise it discovers the OAuth endpoints and prompts you to paste the client_id /
//     client_secret you created in the dashboard (set the redirect URI + a payout there too).
//
// Every prompt can be pre-answered with an env var so an agent can run it non-interactively, e.g.:
//   TRON_API_ORIGIN=https://api.metatron.gg DOMAIN=play.mygame.com \
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

// Discover OAuth endpoints from the OIDC well-known doc, falling back to TRON's conventional paths.
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
    console.log("  using Metatron's conventional endpoints (well-known not available)");
    // Metatron serves authorize + token under /oauth, but userinfo at the root (/userinfo, not
    // /oauth/userinfo). It does not publish /.well-known/openid-configuration, so this fallback is the
    // path that actually runs -- keep it matched to Metatron's real routes.
    return {
        authorize: `${base}/oauth/authorize`,
        token: `${base}/oauth/token`,
        userinfo: `${base}/userinfo`,
    };
}

// API-driven app provisioning against Metatron's developer REST API. Mirrors the real route contracts:
//   POST  /me/developer/apps                     { name }  -> { id }   (no `chains` => "legacy" path:
//         Metatron auto-seeds the payout address per enabled chain from the dev's Privy embedded EOA)
//   PATCH /me/developer/apps/{id}                 { redirectUris, embedOrigins } -> { id }
//   PUT   /me/developer/apps/{id}/keys/{env}      (no body) -> { key: { clientId }, clientSecret }
//   GET   /me/developer                           -> { apps: [{ id, payoutAddresses: [{ chain }] }] }
// All four are reachable with a `tron_dev_…` developer API key. On any mismatch we throw and the
// caller falls back to guided paste.
async function provisionAppViaApi(input: {
    origin: string;
    token: string;
    name: string;
    redirectUri: string;
    embedOrigin: string;
    environment: "development" | "production";
    paymentChain: string;
}): Promise<{ clientId: string; clientSecret: string }> {
    const base = new URL(input.origin).origin;
    // Metatron gates /me/developer/* behind its data-purpose compliance check: every call must declare
    // `x-data-purpose` (account-management for developer self-service) or it 400s before auth.
    const headers = {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
        "x-data-purpose": "account-management",
    };

    // 1. Create the app (name only). The empty-`chains` path makes Metatron seed the payout address
    //    from the developer's own embedded wallet for each enabled chain.
    const createRes = await fetch(`${base}/me/developer/apps`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: input.name }),
    });
    if (!createRes.ok) throw new Error(`create app failed: ${createRes.status} ${await createRes.text()}`);
    const appId = ((await createRes.json()) as { id?: string }).id;
    if (!appId) throw new Error("create app response missing id");

    // 2. Set the redirect URI + embed origin (full-replace allowlists; not accepted at create time).
    const patchRes = await fetch(`${base}/me/developer/apps/${appId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ redirectUris: [input.redirectUri], embedOrigins: [input.embedOrigin] }),
    });
    if (!patchRes.ok) throw new Error(`set redirect/embed failed: ${patchRes.status} ${await patchRes.text()}`);

    // 3. Mint a client credential for the environment (raw secret returned exactly once).
    const keyRes = await fetch(`${base}/me/developer/apps/${appId}/keys/${input.environment}`, {
        method: "PUT",
        headers,
    });
    if (!keyRes.ok) throw new Error(`mint key failed: ${keyRes.status} ${await keyRes.text()}`);
    const key = (await keyRes.json()) as { key?: { clientId?: string }; clientSecret?: string };
    const clientId = key.key?.clientId;
    const clientSecret = key.clientSecret;
    if (!clientId || !clientSecret) throw new Error("mint key response missing clientId/clientSecret");

    console.log(`  created Metatron app ${appId}, set redirect URI, and minted a ${input.environment} key`);

    // 4. Verify a payout address exists for PAYMENT_CHAIN. payments:charge is only grantable with one;
    //    without it sign-in fails with invalid_scope. A miss usually means the dev has no embedded
    //    wallet for that chain yet -- fixable by setting a payout in the dashboard.
    try {
        const meRes = await fetch(`${base}/me/developer`, { headers });
        if (meRes.ok) {
            const me = (await meRes.json()) as {
                apps?: { id: string; payoutAddresses?: { chain: string }[] }[];
            };
            const app = me.apps?.find((a) => a.id === appId);
            const hasPayout = app?.payoutAddresses?.some((p) => p.chain === input.paymentChain) ?? false;
            if (!hasPayout) {
                console.log(
                    `  ! no payout address for chain "${input.paymentChain}" -- set one in the developer ` +
                        `dashboard (your embedded wallet) or payments:charge will fail with invalid_scope.`,
                );
            }
        }
    } catch {
        // verification is best-effort; never block setup on it
    }

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

    const tronOrigin = await ask("Metatron API origin (TRON_API_ORIGIN)", "TRON_API_ORIGIN");
    const domain = await ask("Public domain for production (DOMAIN), or 'localhost'", "DOMAIN", "localhost");
    const env = (await ask("Environment (development/production)", "GAMEKIT_ENV", "development")) as
        | "development"
        | "production";
    const provider = process.env.OAUTH_PROVIDER_NAME ?? "metatron";
    const paymentChain = await ask("Payment chain (PAYMENT_CHAIN)", "PAYMENT_CHAIN", "ethereum-sepolia");
    const paymentToken = await ask(
        "Payment token address (PAYMENT_TOKEN)",
        "PAYMENT_TOKEN",
        "0x0000000000000000000000000000000000000000",
    );

    const endpoints = await discoverEndpoints(tronOrigin);

    // Redirect URI: prod goes through Caddy/Railway under /api; local dev hits the api directly.
    // Local ports are 8788 (api) / 5274 (web) -- high-low owns the kit defaults 8787/5273.
    const isProd = env === "production" && domain !== "localhost";
    const redirectUri = isProd
        ? `https://${domain}/api/auth/callback`
        : "http://localhost:8788/auth/callback";
    const webOrigin = isProd ? `https://${domain}` : "http://localhost:5274";

    // Credentials: API-driven if a dev token is available, else guided paste.
    let clientId: string;
    let clientSecret: string;
    const devToken = process.env.TRON_DEV_TOKEN;
    if (devToken) {
        try {
            console.log("\nProvisioning app via Metatron developer API…");
            const result = await provisionAppViaApi({
                origin: tronOrigin,
                token: devToken,
                name: process.env.GAMEKIT_APP_NAME ?? "game-kit",
                redirectUri,
                embedOrigin: new URL(webOrigin).origin,
                environment: env,
                paymentChain,
            });
            clientId = result.clientId;
            clientSecret = result.clientSecret;
        } catch (e) {
            console.log(`  ! API provisioning failed (${(e as Error).message}). Falling back to paste.`);
            clientId = await ask("OAUTH_CLIENT_ID (from Metatron dashboard)", "OAUTH_CLIENT_ID");
            clientSecret = await ask("OAUTH_CLIENT_SECRET (from Metatron dashboard)", "OAUTH_CLIENT_SECRET");
        }
    } else {
        console.log("\nNo TRON_DEV_TOKEN set — guided setup.");
        console.log("First, in the Metatron web app (local dev: http://localhost:5173): sign in, become a");
        console.log("developer (accept the policy), then create an app. On that app:");
        console.log(`    • set the redirect URI to:  ${redirectUri}`);
        console.log(`    • set the embed origin to:  ${new URL(webOrigin).origin}`);
        console.log(`    • make sure it has a payout address for "${paymentChain}" (your embedded wallet) —`);
        console.log("      without one, payments:charge is refused with invalid_scope.");
        console.log("Then generate a client key and paste the values below.\n");
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
        TRON_API_ORIGIN: new URL(tronOrigin).origin,
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
            API_PORT: "8788",
            // Bring your own Postgres at this URL (dev.sh does not start one); schema auto-bootstraps.
            DATABASE_URL: "postgres://postgres:postgres@localhost:5432/game_kit",
            // REDIS_URL intentionally unset — single-replica local dev uses the in-process backplane.
            LOG_LEVEL: "info",
            ...common,
        }),
        force,
    );

    // deploy/.env for the docker stack. The compose hardcodes the api's DATABASE_URL/REDIS_URL and the
    // postgres service's user (postgres) + db (game_kit), so only POSTGRES_PASSWORD is wired from here.
    const pgPass = process.env.POSTGRES_PASSWORD ?? randomBytes(12).toString("hex");
    writeIfAbsentOrConfirmed(
        join(ROOT, "deploy/.env"),
        renderEnv({
            NODE_ENV: "production",
            DOMAIN: domain,
            ACME_EMAIL: process.env.ACME_EMAIL ?? "",
            POSTGRES_PASSWORD: pgPass,
            NPM_CONFIG_REGISTRY: process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org/",
            LOG_LEVEL: "info",
            ...common,
        }),
        force,
    );

    console.log("\nDone. Next:");
    console.log("  • local dev:  start a Postgres at DATABASE_URL, then ./scripts/dev.sh");
    console.log("  • deploy:     cd deploy && docker compose --env-file .env up -d --build (or use Railway)");
    console.log(`  • confirm ${redirectUri} is a redirect URI on your Metatron app,`);
    console.log(`    and that the app has a payout address for "${paymentChain}" (else payments:charge fails).\n`);

    rl.close();
}

main().catch((err: unknown) => {
    console.error(`\nsetup failed: ${(err as Error).message}`);
    rl.close();
    process.exitCode = 1;
});
