import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createHash, randomBytes } from "node:crypto";
import { env } from "../env.js";
import { db, schema } from "../db/client.js";
import { logger } from "../logger.js";
import { ttgClient } from "../payments/ttg-client.js";
import { attachSessionCookie, createSession, destroySession, loadSessionUser } from "./session.js";

const STATE_COOKIE = "gk_oauth_state";
const VERIFIER_COOKIE = "gk_oauth_verifier";

function base64url(buf: Buffer): string {
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pkce(): { verifier: string; challenge: string } {
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    return { verifier, challenge };
}

export const authRoutes = new Hono();

authRoutes.get("/login", (c) => {
    const state = nanoid(32);
    const { verifier, challenge } = pkce();
    const cookieOpts = {
        httpOnly: true,
        sameSite: "Lax" as const,
        secure: env.NODE_ENV === "production",
        path: "/",
        maxAge: 600,
    };
    setCookie(c, STATE_COOKIE, state, cookieOpts);
    setCookie(c, VERIFIER_COOKIE, verifier, cookieOpts);

    const params = new URLSearchParams({
        response_type: "code",
        client_id: env.OAUTH_CLIENT_ID,
        redirect_uri: env.OAUTH_REDIRECT_URI,
        scope: env.OAUTH_SCOPES,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
    });
    return c.redirect(`${env.OAUTH_AUTHORIZE_URL}?${params.toString()}`);
});

authRoutes.get("/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const expectedState = getCookie(c, STATE_COOKIE);
    const verifier = getCookie(c, VERIFIER_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/" });
    deleteCookie(c, VERIFIER_COOKIE, { path: "/" });

    if (!code || !state || !expectedState || state !== expectedState || !verifier) {
        return c.text("oauth: invalid state or missing parameters", 400);
    }

    // Authorization-code exchange via the SDK back-channel (derives /oauth/token from the issuer,
    // attaches client_id + client_secret; the PKCE verifier travels in the body).
    let tokens: Awaited<ReturnType<typeof ttgClient.oauth.exchangeCode>>;
    try {
        tokens = await ttgClient.oauth.exchangeCode({
            code,
            redirectUri: env.OAUTH_REDIRECT_URI,
            codeVerifier: verifier,
        });
    } catch (error) {
        return c.text(`oauth: token exchange failed (${(error as Error).message})`, 502);
    }

    let info: Awaited<ReturnType<typeof ttgClient.oauth.userInfo>>;
    try {
        info = await ttgClient.oauth.userInfo({ bearer: tokens.access_token });
    } catch (error) {
        return c.text(`oauth: userinfo failed (${(error as Error).message})`, 502);
    }
    if (!info.sub) return c.text("oauth: userinfo missing sub", 502);

    const providerSub = `${env.OAUTH_PROVIDER_NAME}:${info.sub}`;
    const existingRows = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.providerSub, providerSub))
        .limit(1);
    const existing = existingRows[0];

    let userId: string;
    if (existing) {
        userId = existing.id;
    } else {
        userId = nanoid(21);
        await db.insert(schema.users).values({
            id: userId,
            providerSub,
            displayName: info.name ?? "Player",
            // TTG's /userinfo exposes only sub / name / picture (no email by default).
            email: null,
            createdAt: Date.now(),
        });
    }

    const now = Date.now();
    const expiresAt = typeof tokens.expires_in === "number" ? now + tokens.expires_in * 1000 : null;
    await db
        .insert(schema.oauthAccessTokens)
        .values({
            userId,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? null,
            scope: tokens.scope ?? env.OAUTH_SCOPES,
            tokenType: tokens.token_type ?? "Bearer",
            expiresAt,
            issuedAt: now,
        })
        .onConflictDoUpdate({
            target: schema.oauthAccessTokens.userId,
            set: {
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token ?? null,
                scope: tokens.scope ?? env.OAUTH_SCOPES,
                tokenType: tokens.token_type ?? "Bearer",
                expiresAt,
                issuedAt: now,
            },
        });

    const sessionId = await createSession(userId);
    attachSessionCookie(c, sessionId);
    return c.redirect(`${env.WEB_ORIGIN}/lobby`);
});

authRoutes.post("/logout", async (c) => {
    await destroySession(c);
    return c.json({ ok: true });
});

authRoutes.get("/me", async (c) => {
    const user = await loadSessionUser(c);
    if (!user) return c.json({ user: null });
    return c.json({ user });
});

type TokenRow = {
    accessToken: string;
    scope: string;
    expiresAt: number | null;
};

// Refresh ~1 min before expiry so an in-flight request that crosses the boundary still lands valid.
const REFRESH_SKEW_MS = 60_000;

// Coalesce concurrent refreshes per user -- TTG rotates the refresh token on every exchange and
// revokes the chain on reuse, so two parallel callers presenting the same row would log the user
// out. NOTE: this map is per-process. Across replicas, two instances could still race a refresh;
// that's an accepted edge for the template (the loser gets a fresh /auth/login). A Redis lock keyed
// on userId would close it -- left as a documented extension point.
const inflightRefreshes = new Map<string, Promise<TokenRow | null>>();

export async function loadAccessTokenForUser(userId: string): Promise<TokenRow | null> {
    const rows = await db
        .select()
        .from(schema.oauthAccessTokens)
        .where(eq(schema.oauthAccessTokens.userId, userId))
        .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (!shouldRefresh(row.expiresAt) || row.refreshToken === null) {
        return { accessToken: row.accessToken, scope: row.scope, expiresAt: row.expiresAt };
    }
    const refreshToken = row.refreshToken;
    let pending = inflightRefreshes.get(userId);
    if (pending === undefined) {
        pending = rotateRefreshToken(userId, refreshToken).finally(() => {
            inflightRefreshes.delete(userId);
        });
        inflightRefreshes.set(userId, pending);
    }
    return await pending;
}

function shouldRefresh(expiresAt: number | null): boolean {
    if (expiresAt === null) return false;
    return expiresAt - REFRESH_SKEW_MS <= Date.now();
}

async function rotateRefreshToken(userId: string, refreshToken: string): Promise<TokenRow | null> {
    let tokens: Awaited<ReturnType<typeof ttgClient.oauth.refresh>>;
    try {
        tokens = await ttgClient.oauth.refresh({ refreshToken });
    } catch {
        // Chain is dead (revoked / reused / expired) or TTG is down. Drop the row -- a stale row
        // only causes ambiguous 401s later; a transient outage heals on the next /auth/login.
        await db.delete(schema.oauthAccessTokens).where(eq(schema.oauthAccessTokens.userId, userId));
        return null;
    }
    const now = Date.now();
    const expiresAt = typeof tokens.expires_in === "number" ? now + tokens.expires_in * 1000 : null;
    const nextScope = tokens.scope ?? env.OAUTH_SCOPES;
    await db
        .update(schema.oauthAccessTokens)
        .set({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? refreshToken,
            scope: nextScope,
            tokenType: tokens.token_type ?? "Bearer",
            expiresAt,
            issuedAt: now,
        })
        .where(eq(schema.oauthAccessTokens.userId, userId));
    logger.debug({ userId }, "rotated TTG refresh token");
    return { accessToken: tokens.access_token, scope: nextScope, expiresAt };
}
