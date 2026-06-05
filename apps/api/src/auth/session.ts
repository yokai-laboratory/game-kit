import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";

const COOKIE = "gk_session";
const TTL_MS = 1000 * 60 * 60 * 24 * 7;

export interface SessionUser {
    id: string;
    displayName: string;
    email: string | null;
}

// In production the app is served same-origin behind the reverse proxy (web + /api under one
// domain), so a Lax, Secure, HttpOnly cookie is correct. Locally it's HTTP on localhost, so Secure
// is dropped (browsers reject Secure cookies over http).
function cookieSecure(): boolean {
    return env.NODE_ENV === "production";
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

export function attachSessionCookie(c: Context, sessionId: string): void {
    setCookie(c, COOKIE, sessionId, {
        httpOnly: true,
        sameSite: "Lax",
        secure: cookieSecure(),
        path: "/",
        maxAge: Math.floor(TTL_MS / 1000),
    });
}

export function clearSessionCookie(c: Context): void {
    deleteCookie(c, COOKIE, { path: "/" });
}

export async function loadSessionUser(c: Context): Promise<SessionUser | null> {
    const id = getCookie(c, COOKIE);
    if (!id) return null;
    const row = await db
        .select({
            expiresAt: schema.sessions.expiresAt,
            userId: schema.users.id,
            displayName: schema.users.displayName,
            email: schema.users.email,
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
    return { id: found.userId, displayName: found.displayName, email: found.email };
}

export async function destroySession(c: Context): Promise<void> {
    const id = getCookie(c, COOKIE);
    if (id) await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
    clearSessionCookie(c);
}

export const requireUser: MiddlewareHandler<{ Variables: { user: SessionUser } }> = async (c, next) => {
    const user = await loadSessionUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("user", user);
    await next();
};
