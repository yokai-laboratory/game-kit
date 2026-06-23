import type { GameHistoryItem } from "@game-kit/game-core";
import { API_BASE } from "./config";
import { getSessionToken } from "./session";

// Game-agnostic fetch wrapper around the API. Attaches the bearer session token (see session.ts) so
// the request authenticates whether the web is same-origin with the api or on a separate host.
// Callers pass an api-relative path ("/me"); API_BASE resolves to the proxy prefix or the api origin.
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const token = getSessionToken();
    const headers = new Headers(init.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    return fetch(`${API_BASE}${path}`, { ...init, headers });
}

async function json<T>(res: Response): Promise<T> {
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText}: ${body}`);
    }
    return res.json() as Promise<T>;
}

export interface Me {
    user: { id: string; displayName: string; email: string | null; points: number } | null;
}

export async function getMe(): Promise<Me> {
    return json<Me>(await apiFetch("/me"));
}

export interface PointPack {
    id: string;
    points: number;
    priceEth: string;
    title: string;
}

// The store: current points balance + the buyable packs (catalog defined server-side).
export async function getPoints(): Promise<{ balance: number; packs: PointPack[] }> {
    return json(await apiFetch("/payments/points"));
}

export async function logout(): Promise<void> {
    await apiFetch("/auth/logout", { method: "POST" });
}

export interface PresenceConfig {
    tronApiOrigin: string;
    clientId: string;
}

export async function getPresenceConfig(): Promise<PresenceConfig> {
    return json<PresenceConfig>(await apiFetch("/presence/config"));
}

export interface GameInfo {
    id: string;
    displayName: string;
    description: string;
}

export async function listGames(): Promise<{ games: GameInfo[]; defaultGameId: string }> {
    return json(await apiFetch("/rooms/games"));
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
    const data = await json<{ rooms: RoomListItem[] }>(await apiFetch(`/rooms?${qs.toString()}`));
    return data.rooms;
}

export async function createRoom(input: { gameId: string; stakeEth: string; config?: unknown }): Promise<{ id: string; gameId: string }> {
    const data = await json<{ room: { id: string; gameId: string } }>(
        await apiFetch("/rooms", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
        }),
    );
    return data.room;
}

export async function listHistory(limit?: number): Promise<GameHistoryItem[]> {
    const qs = new URLSearchParams();
    if (limit !== undefined) qs.set("limit", String(limit));
    const data = await json<{ items: GameHistoryItem[] }>(await apiFetch(`/rooms/history?${qs.toString()}`));
    return data.items;
}

export async function joinRoom(id: string): Promise<{ id: string; gameId: string }> {
    const data = await json<{ room: { id: string; gameId: string } }>(
        await apiFetch(`/rooms/${id}/join`, { method: "POST" }),
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
    return json<Preflight>(await apiFetch(`/payments/preflight/${roomId}`));
}
