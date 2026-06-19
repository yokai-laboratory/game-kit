import { logger } from "../logger.js";
import { onIntentResolved } from "../game/engine.js";
import { applyIntentTransition, getIntent } from "./intents.js";
import { tronClient } from "./tron-client.js";

// Long-lived subscriber to TRON's /oauth/payments/events channel -- the primary push surface for
// payment-intent lifecycle transitions. The SDK owns the connection lifecycle (handshake, the
// {kind:"subscribed"} first frame, jittered backoff). The poll backstop covers events dropped in a
// reconnect window. NOTE: with multiple API replicas, EVERY replica opens this socket and receives
// every event; applyIntentTransition is idempotent (status='pending' guard) so duplicate processing
// is a no-op, and the room broadcast goes through Redis so whichever replica wins still reaches all
// sockets.

type WebhookBody = {
    event: "intent.completed" | "intent.denied" | "intent.expired" | "intent.txhash_indexed";
    deliveredAt: string;
    intent: {
        intentId: string;
        appId: string;
        status: "pending" | "completed" | "denied" | "expired";
        paymentId: string | null;
        txHash: string | null;
        usdCents: number;
        chain: string;
        resolvedAt: string | null;
        expiresAt: string;
    };
};

export type TronEventsSocket = { readonly stop: () => void };

export function startTronEventsSocket(): TronEventsSocket {
    const subscriber = tronClient.subscribeOauthPaymentEvents({
        onOpen: () => logger.info("tron events socket open"),
        onMessage: (body) => {
            void handleWebhookBody(body as WebhookBody);
        },
        onClose: (error) => logger.warn({ code: error.code, reason: error.reason }, "tron events socket closed"),
        onError: (error) => logger.warn({ err: error.message }, "tron events socket error"),
    });
    return { stop: () => subscriber.stop() };
}

// Shared by the events socket + the poll backstop.
export async function handleWebhookBody(body: WebhookBody): Promise<void> {
    if (typeof body !== "object" || body === null) return;
    const intent = body.intent;
    if (typeof intent?.intentId !== "string") return;

    const existing = await getIntent(intent.intentId);
    if (!existing) {
        logger.debug({ intentId: intent.intentId }, "tron event for unknown intent");
        return;
    }
    if (intent.status === "pending") {
        if (body.event === "intent.txhash_indexed" && intent.txHash !== null) {
            await applyIntentTransition({
                intentId: intent.intentId,
                nextStatus: "completed",
                paymentId: intent.paymentId,
                txHash: intent.txHash,
                resolvedAt: Date.now(),
            });
        }
        return;
    }
    const updated = await applyIntentTransition({
        intentId: intent.intentId,
        nextStatus: intent.status,
        paymentId: intent.paymentId,
        txHash: intent.txHash,
        resolvedAt: Date.now(),
    });
    // Stake completion advances the room; purchase completion credits points. onIntentResolved
    // dispatches on `kind` and is a no-op for non-completed states.
    await onIntentResolved(updated ?? existing);
}
