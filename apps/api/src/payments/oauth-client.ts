import { TtgError as SdkTtgError } from "@titanium-games/sdk/node";

import { ttgClient } from "./ttg-client.js";

// Thin wrapper around Titanium Games' app-initiated payments surface. User-bearer calls carry the
// `payments:charge` scope; app-authority calls (distribute/payout) mint a client_credentials token
// inside the SDK. This file is a pure TTG adapter -- no game or DB knowledge -- so it ports across
// games unchanged.

// Game-attached metadata echoed on the user's TTG activity feed so a charge reads as *why* it
// happened. TTG validates each field, byte-caps the whole object, and SSRF-re-hosts `image`.
export type ChargeMetadata = {
    purpose?: string;
    title?: string;
    note?: string;
    quantity?: number;
    category?: string;
    sessionId?: string;
    image?: string;
    extra?: Record<string, string | number | boolean>;
};

export type ChargeRequestBody = {
    chain: string;
    amount: string;
    token: `0x${string}`;
    returnUri: string;
    // Pot stakes: 0x-prefixed bytes16 pot id. When set, TTG deposits the stake into the shared
    // CreditVault pot (targetKind=Pot) and forces the browser-redirect escrow flow.
    potId?: string;
    metadata?: ChargeMetadata;
};

export type ChargeResponse =
    | { status: "completed"; intentId: string; paymentId: string; usdCents: number; txHash: string | null }
    | { status: "redirect"; intentId: string; redirectUrl: string; usdCents: number }
    | {
          status: "monthly_limit_exceeded";
          currentLimitCents: number;
          monthSpentCents: number;
          attemptedUsdCents: number;
          redirectUrl: string;
      };

export type PaymentLimits = {
    monthlyLimitCents: number | null;
    monthSpentCents: number;
    periodStart: string;
    offlineAutoChargeEnabled: boolean;
    perTxOfflineCapCents: number | null;
};

export type PaymentPrice = {
    chain: string;
    token: string;
    tokenDecimals: number;
    usdRate: string;
    feed: { aggregatorAddress: string; decimals: number; answer: string; updatedAt: string };
    usdCents?: number;
    amount?: string;
};

export type IntentStatus = {
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

export class TtgError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        readonly raw: string,
    ) {
        super(`ttg ${status} ${code}`);
    }
}

// The SDK rejects non-2xx with its own TtgError. Re-shape into this module's TtgError so callers
// keep matching on `instanceof TtgError` + `.status` / `.code`.
function mapTtgError(error: unknown): never {
    if (error instanceof SdkTtgError) throw new TtgError(error.status, error.code, error.body);
    throw error;
}

export function isValidIdempotencyKey(value: string): boolean {
    return /^[A-Za-z0-9_-]{1,255}$/u.test(value);
}

async function parseError(response: Response): Promise<TtgError> {
    const text = await response.text();
    try {
        const body = JSON.parse(text) as { error?: unknown };
        const code = typeof body.error === "string" ? body.error : "unknown";
        return new TtgError(response.status, code, text);
    } catch {
        return new TtgError(response.status, "non_json", text);
    }
}

import { env } from "../env.js";

function ttgUrl(path: string): string {
    return new URL(path, env.TTG_API_ORIGIN).toString();
}

export async function requestCharge(input: {
    bearer: string;
    body: ChargeRequestBody;
    // Reuse the same key across retries of one logical attempt so TTG replays; mint a fresh key
    // for a NEW charge. A missing/malformed key is a 400 server-side.
    idempotencyKey: string;
}): Promise<ChargeResponse> {
    const response = await fetch(ttgUrl("/oauth/payments/charge"), {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${input.bearer}`,
            "idempotency-key": input.idempotencyKey,
        },
        body: JSON.stringify(input.body),
    });
    if (response.status === 402) {
        // "would exceed monthly cap" -- return as a value so the route can render a raise-cap CTA.
        const body = (await response.json()) as {
            error: "monthly_limit_exceeded";
            currentLimitCents: number;
            monthSpentCents: number;
            attemptedUsdCents: number;
            redirectUrl: string;
        };
        return {
            status: "monthly_limit_exceeded",
            currentLimitCents: body.currentLimitCents,
            monthSpentCents: body.monthSpentCents,
            attemptedUsdCents: body.attemptedUsdCents,
            redirectUrl: body.redirectUrl,
        };
    }
    if (!response.ok) throw await parseError(response);
    return (await response.json()) as ChargeResponse;
}

export async function fetchPaymentLimits(input: { bearer: string }): Promise<PaymentLimits> {
    try {
        return (await ttgClient.payments.limits({ bearer: input.bearer })) as PaymentLimits;
    } catch (error) {
        mapTtgError(error);
    }
}

export async function fetchPaymentPrice(input: {
    bearer: string;
    chain: string;
    token: `0x${string}`;
    amount?: string;
    usdCents?: number;
}): Promise<PaymentPrice> {
    try {
        return (await ttgClient.payments.price({
            bearer: input.bearer,
            chain: input.chain,
            token: input.token,
            ...(input.amount === undefined ? {} : { amount: input.amount }),
            ...(input.usdCents === undefined ? {} : { usdCents: input.usdCents }),
        } as Parameters<typeof ttgClient.payments.price>[0])) as PaymentPrice;
    } catch (error) {
        mapTtgError(error);
    }
}

export async function getIntentStatus(input: { bearer: string; intentId: string }): Promise<IntentStatus> {
    try {
        return (await ttgClient.payments.status({ bearer: input.bearer, intentId: input.intentId })) as IntentStatus;
    } catch (error) {
        mapTtgError(error);
    }
}

// Game-initiated pot distribution. App-token bearer (minted by the SDK). TTG signs an EIP-712
// Distribution and relays CreditVault.distributePot, draining the room's pot to the winner legs.
// `settlement` defaults to `locked` (escrow + dispute window) server-side; `closePot` empties it.
export type DistributeLeg = {
    recipientUserId?: string;
    recipient?: `0x${string}`;
    amount: string;
    settlement?: "instant" | "locked";
};

export type DistributeResponse = {
    distributionId: string;
    txHash: string;
    blockNumber: string;
    potId: string;
    closePot: boolean;
    legs: { recipient: string; amount: string; settlement: string }[];
};

export async function requestDistribute(input: {
    chain: string;
    token: `0x${string}`;
    potId: string;
    closePot?: boolean;
    legs: DistributeLeg[];
    metadata?: ChargeMetadata;
}): Promise<DistributeResponse> {
    try {
        return (await ttgClient.payments.distribute({
            body: {
                chain: input.chain,
                token: input.token,
                potId: input.potId,
                ...(input.closePot === undefined ? {} : { closePot: input.closePot }),
                legs: input.legs,
                ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            },
        } as Parameters<typeof ttgClient.payments.distribute>[0])) as DistributeResponse;
    } catch (error) {
        mapTtgError(error);
    }
}
