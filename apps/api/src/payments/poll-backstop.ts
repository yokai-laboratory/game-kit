import { loadAccessTokenForUser } from "../auth/oauth.js";
import { onIntentResolved } from "../game/engine.js";
import { logger } from "../logger.js";
import { applyIntentTransition, listExpiredPendingIntents } from "./intents.js";
import { getIntentStatus, TronError } from "./oauth-client.js";

// Polling backstop for the events socket. Every 30s it finds locally-pending intents past their
// TRON-side TTL and asks TRON for the canonical state. Covers: socket reconnect windows, dropped
// webhooks, and janitor expiry. Runs on every replica; applyIntentTransition is idempotent so
// overlap is harmless.
//
// SCALING NOTE: at large replica counts you'd elect one poller (e.g. a Redis lock) instead of all
// of them scanning. For a single-VPS / few-replica template, N pollers hitting an idempotent path
// is fine and simpler.

const POLL_INTERVAL_MS = 30_000;
const BATCH_LIMIT = 25;

export type PollBackstop = { readonly stop: () => void };

export function startPollBackstop(): PollBackstop {
    let stopped = false;
    const handle = setInterval(() => {
        void tick().catch((err: unknown) => logger.error({ err }, "poll tick threw"));
    }, POLL_INTERVAL_MS);
    handle.unref?.();
    return {
        stop() {
            stopped = true;
            clearInterval(handle);
        },
    };

    async function tick(): Promise<void> {
        if (stopped) return;
        const rows = await listExpiredPendingIntents({ now: Date.now(), limit: BATCH_LIMIT });
        for (const row of rows) {
            if (stopped) return;
            const tokenRow = await loadAccessTokenForUser(row.userId);
            if (!tokenRow) {
                logger.warn({ intentId: row.id, userId: row.userId }, "poll skipped: no access token");
                continue;
            }
            let upstream;
            try {
                upstream = await getIntentStatus({ bearer: tokenRow.accessToken, intentId: row.id });
            } catch (e) {
                if (e instanceof TronError) {
                    logger.warn({ intentId: row.id, code: e.code, status: e.status }, "tron status failed");
                    continue;
                }
                throw e;
            }
            if (upstream.status === "pending") continue;
            const updated = await applyIntentTransition({
                intentId: row.id,
                nextStatus: upstream.status,
                paymentId: upstream.paymentId,
                txHash: upstream.txHash,
                resolvedAt: Date.now(),
            });
            if (updated) await onIntentResolved(updated);
        }
    }
}
