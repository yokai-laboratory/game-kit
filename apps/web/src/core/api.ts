import type { GameHistoryItem } from "@game-kit/game-core";

// Tiny fetch wrapper around the API. All calls are same-origin (/api is proxied in dev, served by
// Caddy in prod) and credentialed so the session cookie travels. Game-agnostic.

const BASE = "/api";

async function json<T>(res: Response): Promise<T> {
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText}: ${body}`);
    }
    return res.json() as Promise<T>;
}

export interface Me {
    user: { id: string; displayName: string; email: string | null } | null;
}

export async function getMe(): Promise<Me> {
    return json<Me>(await fetch(`${BASE}/me`, { credentials: "include" }));
}

export async function logout(): Promise<void> {
    await fetch(`${BASE}/auth/logout`, { method: "POST", credentials: "include" });
}

export interface PresenceConfig {
    ttgApiOrigin: string;
    clientId: string;
}

export async function getPresenceConfig(): Promise<PresenceConfig> {
    return json<PresenceConfig>(await fetch(`${BASE}/presence/config`, { credentials: "include" }));
}

export interface GameInfo {
    id: string;
    displayName: string;
    description: string;
}

export async function listGames(): Promise<{ games: GameInfo[]; defaultGameId: string }> {
    return json(await fetch(`${BASE}/rooms/games`, { credentials: "include" }));
}

export interface RoomListItem {
    id: string;
    gameId: string;
    stakeEth: string;
    status: "awaiting_host_stake" | "waiting" | "awaiting_guest_stake" | "in_progress";
    hostUserId: string;
    hostDisplayName: string;
    guestUserId: string | null;
    createdAt: number;
}

export async function listRooms(params: { gameId?: string; minStake?: number; maxStake?: number }): Promise<RoomListItem[]> {
    const qs = new URLSearchParams();
    if (params.gameId) qs.set("gameId", params.gameId);
    if (params.minStake !== undefined) qs.set("minStake", String(params.minStake));
    if (params.maxStake !== undefined) qs.set("maxStake", String(params.maxStake));
    const data = await json<{ rooms: RoomListItem[] }>(
        await fetch(`${BASE}/rooms?${qs.toString()}`, { credentials: "include" }),
    );
    return data.rooms;
}

export async function createRoom(input: { gameId: string; stakeEth: string; config?: unknown }): Promise<{ id: string; gameId: string }> {
    const data = await json<{ room: { id: string; gameId: string } }>(
        await fetch(`${BASE}/rooms`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
        }),
    );
    return data.room;
}

export async function listHistory(limit?: number): Promise<GameHistoryItem[]> {
    const qs = new URLSearchParams();
    if (limit !== undefined) qs.set("limit", String(limit));
    const data = await json<{ items: GameHistoryItem[] }>(
        await fetch(`${BASE}/rooms/history?${qs.toString()}`, { credentials: "include" }),
    );
    return data.items;
}

export async function joinRoom(id: string): Promise<{ id: string; gameId: string }> {
    const data = await json<{ room: { id: string; gameId: string } }>(
        await fetch(`${BASE}/rooms/${id}/join`, { method: "POST", credentials: "include" }),
    );
    return data.room;
}

export interface Preflight {
    stake: { roomId: string; stakeEth: string; amountWei: string; usdCents: number; usdRate: string };
    limits: {
        monthlyLimitCents: number | null;
        monthSpentCents: number;
        periodStart: string;
        offlineAutoChargeEnabled: boolean;
        perTxOfflineCapCents: number | null;
    };
    derived: { remainingCents: number | null; willExceedCap: boolean; willChargeInstantly: boolean };
}

export async function getPreflight(roomId: string): Promise<Preflight> {
    return json<Preflight>(await fetch(`${BASE}/payments/preflight/${roomId}`, { credentials: "include" }));
}
