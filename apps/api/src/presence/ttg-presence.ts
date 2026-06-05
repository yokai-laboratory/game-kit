import type { PlaySessionGameStatus } from "@titanium-games/sdk/node";
import { eq } from "drizzle-orm";

import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { ttgClient } from "../payments/ttg-client.js";

export type { PlaySessionGameStatus };

// Active-play presence -- the GAME side of TTG's mutual-attestation handshake. The USER half is
// driven by TTG's origin-isolated widget in the player's own browser (it mints + heartbeats with
// the player's first-party TTG session, which this server can neither read nor replay). The browser
// relays only the minted playSessionId over the room socket; this module drives the GAME half off
// that id with the app's client credentials. A session reads `active` on TTG only while BOTH halves
// are fresh -- so "active" genuinely means the player's browser is present. This is the precondition
// for firing a silent offline charge instead of bouncing the user to a redirect.
//
// Best-effort throughout: any failure just means no game half for that player; gameplay never
// depends on it.

// A third of TTG's 45s half-TTL: one dropped beat is tolerated before the half lapses.
const HEARTBEAT_INTERVAL_MS = 15_000;

// Resolve the TTG user id for a local user (the OAuth sub, stored as `<provider>:<sub>`).
export async function resolveTtgUserId(userId: string): Promise<string | null> {
    const prefix = `${env.OAUTH_PROVIDER_NAME}:`;
    const rows = await db
        .select({ providerSub: schema.users.providerSub })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
    const row = rows[0];
    if (!row || !row.providerSub.startsWith(prefix)) return null;
    const ttgUserId = row.providerSub.slice(prefix.length);
    return ttgUserId.length === 0 ? null : ttgUserId;
}

// The GAME half of one player's presence, for the lifetime of a room socket. Confirms once, then
// heartbeats until stop(). Fails closed.
export class PlayerPresence {
    private gameBeat: ReturnType<typeof setInterval> | null = null;
    private stopped = false;
    private lastStatus: PlaySessionGameStatus | null = null;

    constructor(
        private readonly playSessionId: string,
        private readonly ttgUserId: string,
        private readonly onStatus?: (status: PlaySessionGameStatus) => void,
    ) {
        void this.begin();
    }

    private emit(status: PlaySessionGameStatus): void {
        if (status === this.lastStatus) return;
        this.lastStatus = status;
        this.onStatus?.(status);
    }

    private async begin(): Promise<void> {
        try {
            const { status } = await ttgClient.presence.confirm({
                playSessionId: this.playSessionId,
                userId: this.ttgUserId,
            });
            if (this.stopped) {
                await ttgClient.presence.end({ playSessionId: this.playSessionId }).catch(() => undefined);
                return;
            }
            this.emit(status);
            this.gameBeat = setInterval(() => {
                void ttgClient.presence
                    .heartbeat({ playSessionId: this.playSessionId })
                    .then(({ status: beat }) => {
                        if (!this.stopped) this.emit(beat);
                    })
                    .catch(() => undefined);
            }, HEARTBEAT_INTERVAL_MS);
        } catch (error) {
            logger.warn({ err: error }, "presence game-half start failed");
        }
    }

    async stop(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        if (this.gameBeat !== null) {
            clearInterval(this.gameBeat);
            this.gameBeat = null;
        }
        this.emit("ended");
        await ttgClient.presence.end({ playSessionId: this.playSessionId }).catch(() => undefined);
    }
}

// Start the game half for a browser-relayed playSessionId. Returns null when the user can't be
// mapped to a TTG user id.
export async function startGameHalfPresence(
    userId: string,
    playSessionId: string,
    onStatus?: (status: PlaySessionGameStatus) => void,
): Promise<PlayerPresence | null> {
    const ttgUserId = await resolveTtgUserId(userId);
    if (ttgUserId === null) return null;
    return new PlayerPresence(playSessionId, ttgUserId, onStatus);
}
