import { TronError, type PlaySessionGameStatus } from "@metatrongg/sdk/node";
import { eq } from "drizzle-orm";

import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { tronClient } from "../payments/tron-client.js";

export type { PlaySessionGameStatus };

// Active-play presence -- the GAME side of TRON's mutual-attestation handshake. The USER half is
// driven by TRON's origin-isolated widget in the player's own browser (it mints + heartbeats with
// the player's first-party TRON session, which this server can neither read nor replay). The browser
// relays only the minted playSessionId over the room socket; this module drives the GAME half off
// that id with the app's client credentials. A session reads `active` on TRON only while BOTH halves
// are fresh -- so "active" genuinely means the player's browser is present. This is the precondition
// for firing a silent offline charge instead of bouncing the user to a redirect.
//
// Best-effort throughout: any failure just means no game half for that player; gameplay never
// depends on it.

// A third of TRON's 45s half-TTL: one dropped beat is tolerated before the half lapses.
const HEARTBEAT_INTERVAL_MS = 15_000;

// Resolve the TRON user id for a local user (the OAuth sub, stored as `<provider>:<sub>`).
export async function resolveTronUserId(userId: string): Promise<string | null> {
    const prefix = `${env.OAUTH_PROVIDER_NAME}:`;
    const rows = await db
        .select({ providerSub: schema.users.providerSub })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
    const row = rows[0];
    if (!row || !row.providerSub.startsWith(prefix)) return null;
    const tronUserId = row.providerSub.slice(prefix.length);
    return tronUserId.length === 0 ? null : tronUserId;
}

// The GAME half of one player's presence, for the lifetime of a room socket. Confirms once, then
// heartbeats until stop(). Fails closed.
export class PlayerPresence {
    private gameBeat: ReturnType<typeof setInterval> | null = null;
    private stopped = false;
    private lastStatus: PlaySessionGameStatus | null = null;

    constructor(
        private readonly playSessionId: string,
        private readonly tronUserId: string,
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
            const { status } = await tronClient.presence.confirm({
                playSessionId: this.playSessionId,
                userId: this.tronUserId,
            });
            if (this.stopped) return;
            this.emit(status);
            this.startBeats();
        } catch (error) {
            // The confirm nonce is SINGLE-USE. A room socket reconnect re-relays the same
            // playSessionId, and re-confirming it 404s even though the session is alive and this
            // app already holds its game half. Resume by heartbeating instead — it refreshes the
            // game-half TTL without needing the nonce. Only if THAT fails is the session dead.
            if (error instanceof TronError && error.status === 404) {
                try {
                    const { status } = await tronClient.presence.heartbeat({ playSessionId: this.playSessionId });
                    if (this.stopped) return;
                    this.emit(status);
                    this.startBeats();
                    return;
                } catch {
                    /* genuinely dead — fall through */
                }
            }
            logger.warn({ err: error }, "presence game-half start failed");
            this.emit("ended");
        }
    }

    private startBeats(): void {
        this.gameBeat = setInterval(() => {
            void tronClient.presence
                .heartbeat({ playSessionId: this.playSessionId })
                .then(({ status: beat }) => {
                    if (!this.stopped) this.emit(beat);
                })
                .catch(() => undefined);
        }, HEARTBEAT_INTERVAL_MS);
    }

    /**
     * Stop driving the game half. `endSession` tears the platform session down for good — do that
     * ONLY when a fresh playSessionId replaces this one. A transient socket close must NOT end
     * the session (the user's browser widget is still attesting; ending here would kill a session
     * the reconnect wants to resume — the "presence: ended" death spiral). Left alone, the game
     * half lapses via its own TTL if nobody resumes.
     */
    async stop(endSession = false): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        if (this.gameBeat !== null) {
            clearInterval(this.gameBeat);
            this.gameBeat = null;
        }
        if (endSession) {
            this.emit("ended");
            await tronClient.presence.end({ playSessionId: this.playSessionId }).catch(() => undefined);
        }
    }
}

// Start the game half for a browser-relayed playSessionId. Returns null when the user can't be
// mapped to a TRON user id.
export async function startGameHalfPresence(
    userId: string,
    playSessionId: string,
    onStatus?: (status: PlaySessionGameStatus) => void,
): Promise<PlayerPresence | null> {
    const tronUserId = await resolveTronUserId(userId);
    if (tronUserId === null) return null;
    return new PlayerPresence(playSessionId, tronUserId, onStatus);
}
