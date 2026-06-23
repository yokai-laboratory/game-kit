import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { db, schema } from "../db/client.js";

const TTL_MS = 1000 * 60 * 60 * 24 * 7;

export interface SessionUser {
    id: string;
    displayName: string;
    email: string | null;
    points: number;
}

// Bearer-token session model. The browser session is NOT a cookie. The platform hands each game a
// frontend subdomain that points at wherever the dev hosts the api, so the web and the api commonly
// live on different registrable domains -- and browsers block third-party cookies regardless of
// SameSite, so a session cookie set on the api domain is never sent on a cross-site fetch/WS from the
// web. Instead the OAuth callback hands the opaque session id back in a URL fragment; the web stores
// it and presents it as `Authorization: Bearer <id>` on REST calls and `?token=<id>` on the WS
// upgrade (browsers can't set headers on a WebSocket). Origin-agnostic: works unchanged whether the
// web is same-origin behind a reverse proxy or on a separate domain -- no per-deploy config. The
// token IS the session row id (opaque, no JWT). The OAuth PKCE state/verifier stay cookies: they're
// first-party to the api domain (set on /auth/login, read on /auth/callback, both on the api) and
// Lax cookies ride the top-level redirect back through TRON.
function sessionTokenFrom(c: Context): string | null {
    const header = c.req.header("authorization");
    if (header) {
        const [scheme, value] = header.split(/\s+/u);
        if (scheme?.toLowerCase() === "bearer" && value) return value;
    }
    // WebSocket upgrade can't carry an Authorization header, so the web passes ?token= instead.
    return c.req.query("token") ?? null;
}

export async function createSession(userId: string): Promise<string> {
    const id = nanoid(40);
    const now = Date.now();
    await db.insert(schema.sessions).values({
        id,
        userId,
        expiresAt: now + TTL_MS,
        createdAt: now,
    });
    return id;
}

export async function loadSessionUser(c: Context): Promise<SessionUser | null> {
    const id = sessionTokenFrom(c);
    if (!id) return null;
    const row = await db
        .select({
            expiresAt: schema.sessions.expiresAt,
            userId: schema.users.id,
            displayName: schema.users.displayName,
            email: schema.users.email,
            points: schema.users.points,
        })
        .from(schema.sessions)
        .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
        .where(eq(schema.sessions.id, id))
        .limit(1);
    const found = row[0];
    if (!found) return null;
    if (found.expiresAt < Date.now()) {
        await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
        return null;
    }
    return { id: found.userId, displayName: found.displayName, email: found.email, points: found.points };
}

export async function destroySession(c: Context): Promise<void> {
    const id = sessionTokenFrom(c);
    if (id) await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
}

export const requireUser: MiddlewareHandler<{ Variables: { user: SessionUser } }> = async (c, next) => {
    const user = await loadSessionUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("user", user);
    await next();
};
