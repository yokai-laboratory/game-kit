import { useCallback, useState } from "react";
import { apiFetch } from "./api";

// Drives the TRON /oauth/payments/charge flow from the web side. The API proxies the call
// server-to-server with the user's stored bearer; the response tells us whether the charge
// completed silently (offline auto-charge) or needs the user to confirm on TRON's /pay page.

export type ChargeStatus =
    | { kind: "idle" }
    | { kind: "requesting" }
    | { kind: "completed"; intentId: string }
    | { kind: "redirecting"; intentId: string; redirectUrl: string }
    | {
          kind: "limit_exceeded";
          currentLimitCents: number;
          monthSpentCents: number;
          attemptedUsdCents: number;
          redirectUrl: string;
      }
    // TRON rail: the ledger balance can't cover the stake. The user tops up on TRON (profile -> TRON
    // balance) and retries; there is no redirect flow to follow.
    | { kind: "insufficient_tron"; balanceCents: number; requiredCents: number }
    | { kind: "error"; message: string };

type ChargeResponse =
    | { status: "completed"; intentId: string }
    | { status: "redirect"; intentId: string; redirectUrl: string; usdCents: number }
    | {
          status: "monthly_limit_exceeded";
          currentLimitCents: number;
          monthSpentCents: number;
          attemptedUsdCents: number;
          redirectUrl: string;
      }
    | { status: "insufficient_tron"; balanceCents: number; requiredCents: number };

export function useCharge(): { status: ChargeStatus; charge: (roomId: string) => Promise<void>; reset: () => void } {
    const [status, setStatus] = useState<ChargeStatus>({ kind: "idle" });

    const charge = useCallback(async (roomId: string) => {
        setStatus({ kind: "requesting" });
        try {
            const res = await apiFetch("/payments/charge", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ roomId }),
            });
            if (res.status === 402) {
                // Two structured 402s share this branch: monthly cap reached (ETH rail, has a
                // raise-cap redirect) or TRON ledger balance too low (top up + retry).
                const data = (await res.json()) as Extract<
                    ChargeResponse,
                    { status: "monthly_limit_exceeded" } | { status: "insufficient_tron" }
                >;
                if (data.status === "insufficient_tron") {
                    setStatus({ kind: "insufficient_tron", balanceCents: data.balanceCents, requiredCents: data.requiredCents });
                    return;
                }
                setStatus({
                    kind: "limit_exceeded",
                    currentLimitCents: data.currentLimitCents,
                    monthSpentCents: data.monthSpentCents,
                    attemptedUsdCents: data.attemptedUsdCents,
                    redirectUrl: data.redirectUrl,
                });
                return;
            }
            if (!res.ok) {
                const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
                throw new Error(body.code ?? body.error ?? `charge_failed_${res.status}`);
            }
            const data = (await res.json()) as ChargeResponse;
            if (data.status === "completed") {
                setStatus({ kind: "completed", intentId: data.intentId });
                return;
            }
            if (data.status === "redirect") {
                setStatus({ kind: "redirecting", intentId: data.intentId, redirectUrl: data.redirectUrl });
                window.location.href = data.redirectUrl;
                return;
            }
            // The 402-shaped variants only land here if the api ever returned them with a 2xx (it
            // doesn't today). The exhaustive narrow keeps the type checker honest if that changes.
            if (data.status === "insufficient_tron") {
                setStatus({ kind: "insufficient_tron", balanceCents: data.balanceCents, requiredCents: data.requiredCents });
                return;
            }
            setStatus({
                kind: "limit_exceeded",
                currentLimitCents: data.currentLimitCents,
                monthSpentCents: data.monthSpentCents,
                attemptedUsdCents: data.attemptedUsdCents,
                redirectUrl: data.redirectUrl,
            });
        } catch (e) {
            setStatus({ kind: "error", message: e instanceof Error ? e.message : "charge failed" });
        }
    }, []);

    const reset = useCallback(() => setStatus({ kind: "idle" }), []);
    return { status, charge, reset };
}

// Same flow as useCharge, but for a one-way store purchase (POST /payments/purchase with a packId).
// The response shape is identical -- completed (offline auto-charge: points already credited),
// redirect (confirm on TRON, points credited on return), or monthly_limit_exceeded -- so the caller
// reuses ChargeStatus. On `completed` the caller should refresh the user (the balance changed).
export function usePurchase(): { status: ChargeStatus; purchase: (packId: string) => Promise<void>; reset: () => void } {
    const [status, setStatus] = useState<ChargeStatus>({ kind: "idle" });

    const purchase = useCallback(async (packId: string) => {
        setStatus({ kind: "requesting" });
        try {
            const res = await apiFetch("/payments/purchase", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ packId }),
            });
            if (res.status === 402) {
                const data = (await res.json()) as Extract<ChargeResponse, { status: "monthly_limit_exceeded" }>;
                setStatus({
                    kind: "limit_exceeded",
                    currentLimitCents: data.currentLimitCents,
                    monthSpentCents: data.monthSpentCents,
                    attemptedUsdCents: data.attemptedUsdCents,
                    redirectUrl: data.redirectUrl,
                });
                return;
            }
            if (!res.ok) {
                const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
                throw new Error(body.code ?? body.error ?? `purchase_failed_${res.status}`);
            }
            const data = (await res.json()) as ChargeResponse;
            if (data.status === "completed") {
                setStatus({ kind: "completed", intentId: data.intentId });
                return;
            }
            if (data.status === "redirect") {
                setStatus({ kind: "redirecting", intentId: data.intentId, redirectUrl: data.redirectUrl });
                window.location.href = data.redirectUrl;
                return;
            }
            // Store purchases are ETH-only, so insufficient_tron never lands here; narrow it out to
            // keep the exhaustive check honest.
            if (data.status === "insufficient_tron") return;
            setStatus({
                kind: "limit_exceeded",
                currentLimitCents: data.currentLimitCents,
                monthSpentCents: data.monthSpentCents,
                attemptedUsdCents: data.attemptedUsdCents,
                redirectUrl: data.redirectUrl,
            });
        } catch (e) {
            setStatus({ kind: "error", message: e instanceof Error ? e.message : "purchase failed" });
        }
    }, []);

    const reset = useCallback(() => setStatus({ kind: "idle" }), []);
    return { status, purchase, reset };
}

// Used by /payment-return: ask the API to poll TRON once for the canonical intent state.
export async function syncIntent(intentId: string): Promise<{
    intent: { id: string; roomId: string; status: "pending" | "completed" | "denied" | "expired" };
    changed: boolean;
}> {
    const res = await apiFetch(`/payments/intent/${encodeURIComponent(intentId)}/sync`, { method: "POST" });
    if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `sync_failed_${res.status}`);
    }
    return (await res.json()) as {
        intent: { id: string; roomId: string; status: "pending" | "completed" | "denied" | "expired" };
        changed: boolean;
    };
}
