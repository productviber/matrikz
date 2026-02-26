/**
 * Payout Provider — Abstraction layer for payment disbursements.
 *
 * Provides a single `processPayoutItem()` function whose implementation
 * can be swapped per environment or provider.  The stub records the
 * attempt and returns a mock reference so the rest of the payout
 * pipeline works end-to-end without a real payment rail.
 *
 * To add a real provider (e.g. PayPal Payouts, Stripe Payouts,
 * Wise Business):
 *   1. Implement `PayoutProvider` below.
 *   2. Select it based on `env.PAYOUT_PROVIDER`.
 */

import type { Env } from '../types';

export interface PayoutRequest {
  affiliateCode: string;
  email: string;
  amountCents: number;
  batchId: number;
}

export interface PayoutResult {
  success: boolean;
  /** Provider-assigned transaction reference */
  reference: string;
  errorMessage?: string;
}

export interface PayoutProvider {
  process(req: PayoutRequest, env: Env): Promise<PayoutResult>;
}

// ─── Stub Provider (default) ────────────────────────────────────────────────

/**
 * Stub provider — records intent, returns a deterministic reference.
 * Safe to use in development/staging.  Replace with a real provider
 * before handling real money.
 */
class StubPayoutProvider implements PayoutProvider {
  async process(req: PayoutRequest, _env: Env): Promise<PayoutResult> {
    console.log(
      `[Payouts:Stub] Would pay ${req.email} $${(req.amountCents / 100).toFixed(2)} ` +
      `for batch #${req.batchId} (affiliate: ${req.affiliateCode})`
    );
    // Generate a deterministic stub reference
    const reference = `STUB-${req.batchId}-${req.affiliateCode}-${Date.now()}`;
    return { success: true, reference };
  }
}

// ─── Provider Registry ──────────────────────────────────────────────────────

const providers: Record<string, PayoutProvider> = {
  stub: new StubPayoutProvider(),
};

/**
 * Resolve the active payout provider from the environment.
 * Defaults to the stub if `PAYOUT_PROVIDER` is not set or unknown.
 */
export function getPayoutProvider(env: Env): PayoutProvider {
  const name = (env as any).PAYOUT_PROVIDER ?? 'stub';
  return providers[name] ?? providers['stub'];
}

/**
 * Convenience wrapper — process a single payout using the active provider.
 */
export async function processPayoutItem(
  env: Env,
  req: PayoutRequest
): Promise<PayoutResult> {
  const provider = getPayoutProvider(env);
  try {
    return await provider.process(req, env);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[Payouts] Provider error for ${req.affiliateCode}:`, errorMessage);
    return { success: false, reference: '', errorMessage };
  }
}
