/**
 * Payout Provider — Abstraction layer for payment disbursements.
 *
 * Provides a single `processPayoutItem()` function whose implementation
 * is selected per environment by the `PAYOUT_PROVIDER` binding variable.
 *
 * Supported providers:
 *   stub     — Default. Records intent only; safe for dev/staging.
 *   razorpay — Razorpay X2B (Business→Beneficiary) using contacts/fund_accounts/payouts APIs.
 *              Requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET secrets.
 *              Affiliate must have payout details stored in KV (UPI or bank method).
 *              NOTE: amount_cents is treated as INR paise by this provider.
 *   stripe   — Stripe Transfer API. Requires STRIPE_SECRET_KEY secret.
 *              Affiliate must have a Stripe connected account ID in KV.
 *              NOTE: amount_cents is treated as USD cents by this provider.
 *
 * Payout details per affiliate are stored in KV under:
 *   `affiliate-payout:{code}` → JSON of `PayoutDetails`
 *
 * All events are logged to the `payout_events` D1 table for admin auditing.
 *
 * Patterns reused from visibility-analytics:
 *   - Basic auth via btoa(key_id:key_secret)
 *   - HMAC-SHA256 signature via crypto.subtle
 *   - Retry-with-backoff for resilience (lightweight circuit breaker)
 */

import type { Env, PayoutDetails, UpiPayoutDetails, BankPayoutDetails, StripePayoutDetails } from '../types';
import {
  KV_PREFIX,
  RAZORPAY_API,
  STRIPE_API,
  PAYOUT_PROVIDERS,
  PAYOUT_EVENT,
  TTL,
} from '../constants';
import { execute } from './db';

// ─── Public Interfaces ──────────────────────────────────────────────────────

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

// ─── Payout Event Logging ───────────────────────────────────────────────────

/**
 * Append a structured audit event to the `payout_events` table.
 * Failures are swallowed so they don't abort the payout pipeline.
 */
async function logPayoutEvent(
  env: Env,
  opts: {
    batchId: number;
    affiliateCode: string;
    eventType: string;
    provider: string;
    reference: string | null;
    amountCents: number;
    status: 'success' | 'failure';
    error?: string;
  }
): Promise<void> {
  try {
    await execute(
      env.DB,
      `INSERT INTO payout_events
         (batch_id, affiliate_code, event_type, provider, reference, amount_cents, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        opts.batchId,
        opts.affiliateCode,
        opts.eventType,
        opts.provider,
        opts.reference ?? null,
        opts.amountCents,
        opts.status,
        opts.error ?? null,
      ]
    );
  } catch (err) {
    console.error(`[PayoutEvents] Failed to log event for ${opts.affiliateCode}:`, err);
  }
}

// ─── KV Payout Details Helper ───────────────────────────────────────────────

/**
 * Retrieve an affiliate's saved payout method details from KV.
 * Returns null when no details have been configured.
 */
export async function getAffiliatePayoutDetails(
  env: Env,
  affiliateCode: string
): Promise<PayoutDetails | null> {
  const raw = await env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_PAYOUT_DETAILS}${affiliateCode}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PayoutDetails;
  } catch {
    console.error(`[PayoutDetails] Corrupt KV entry for affiliate ${affiliateCode}`);
    return null;
  }
}

/**
 * Persist an affiliate's payout method details to KV.
 */
export async function saveAffiliatePayoutDetails(
  env: Env,
  affiliateCode: string,
  details: PayoutDetails
): Promise<void> {
  await env.KV_MARKETING.put(
    `${KV_PREFIX.AFFILIATE_PAYOUT_DETAILS}${affiliateCode}`,
    JSON.stringify(details),
    { expirationTtl: TTL.YEAR_1 }
  );
}

// ─── Retry / Circuit Breaker ────────────────────────────────────────────────

/**
 * Lightweight retry with exponential backoff.
 * Mirrors the circuit-breaker pattern used in visibility-analytics
 * for outbound payment API calls.
 *
 * @param fn      Async function to attempt
 * @param retries Number of total attempts (default 3)
 * @param baseMs  Initial delay in milliseconds (doubles each attempt)
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  baseMs = 500
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, baseMs * (2 ** (attempt - 1))));
      }
    }
  }
  throw lastErr;
}

// ─── HMAC-SHA256 Helper (reused from visibility-analytics) ─────────────────

/**
 * Generate an HMAC-SHA256 hex signature.
 * Identical pattern to visibility-analytics/src/workers/payment-handler.mjs.
 */
async function hmacSha256(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Stub Provider (default) ────────────────────────────────────────────────

/**
 * Stub provider — records intent only, returns a deterministic reference.
 * Safe for development and staging. Replace PAYOUT_PROVIDER with a real
 * provider before disbursing actual funds.
 */
class StubPayoutProvider implements PayoutProvider {
  async process(req: PayoutRequest, env: Env): Promise<PayoutResult> {
    const reference = `STUB-${req.batchId}-${req.affiliateCode}-${Date.now()}`;
    console.log(
      `[Payouts:Stub] Would pay ${req.email} ` +
      `${(req.amountCents / 100).toFixed(2)} units ` +
      `for batch #${req.batchId} (affiliate: ${req.affiliateCode}) ref=${reference}`
    );
    await logPayoutEvent(env, {
      batchId: req.batchId,
      affiliateCode: req.affiliateCode,
      eventType: PAYOUT_EVENT.SUCCEEDED,
      provider: PAYOUT_PROVIDERS.STUB,
      reference,
      amountCents: req.amountCents,
      status: 'success',
    });
    return { success: true, reference };
  }
}

// ─── Razorpay X2B Provider ──────────────────────────────────────────────────

/**
 * Razorpay Business-to-Beneficiary payout provider.
 *
 * Flow:
 *   1. Read affiliate payout details (UPI or bank) from KV
 *   2. Create or reuse a Razorpay Contact
 *   3. Create a Fund Account linked to the Contact
 *   4. Schedule a Payout against the Fund Account
 *
 * Auth:  `Authorization: Basic btoa(key_id:key_secret)`
 * Idempotency key: `visibility-marketing-{batchId}-{affiliateCode}`
 *
 * NOTE: `amountCents` is treated as INR paise (1 INR = 100 paise).
 *       Administrators should set payout amounts in paise when using this provider.
 *
 * Documentation: https://razorpay.com/docs/razorpayx/payouts/
 */
class RazorpayPayoutProvider implements PayoutProvider {
  private authHeader(env: Env): string {
    const keyId = (env as any).RAZORPAY_KEY_ID as string;
    const keySecret = (env as any).RAZORPAY_KEY_SECRET as string;
    return `Basic ${btoa(`${keyId}:${keySecret}`)}`;
  }

  private idempotencyKey(batchId: number, affiliateCode: string, step: string): string {
    return `visibility-marketing-${batchId}-${affiliateCode}-${step}`;
  }

  private async post<T>(url: string, body: unknown, authHeader: string, idempotencyKey: string): Promise<T> {
    const response = await withRetry(() =>
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'X-Payout-Idempotency': idempotencyKey,
        },
        body: JSON.stringify(body),
      })
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => response.statusText);
      throw new Error(`Razorpay ${url} failed [${response.status}]: ${errorBody}`);
    }

    return response.json() as Promise<T>;
  }

  async process(req: PayoutRequest, env: Env): Promise<PayoutResult> {
    const { affiliateCode, email, amountCents, batchId } = req;
    const provider = PAYOUT_PROVIDERS.RAZORPAY;
    const auth = this.authHeader(env);

    console.log(`[Payouts:Razorpay] Starting payout for ${affiliateCode} batch #${batchId} amount=${amountCents}`);

    await logPayoutEvent(env, {
      batchId, affiliateCode, eventType: PAYOUT_EVENT.INITIATED, provider,
      reference: null, amountCents, status: 'success',
    });

    // ── Step 1: Get affiliate payout details ──
    const details = await getAffiliatePayoutDetails(env, affiliateCode);
    if (!details) {
      const error = `No payout details configured for affiliate ${affiliateCode}`;
      console.warn(`[Payouts:Razorpay] ${error}`);
      await logPayoutEvent(env, {
        batchId, affiliateCode, eventType: PAYOUT_EVENT.SKIPPED, provider,
        reference: null, amountCents, status: 'failure', error,
      });
      return { success: false, reference: '', errorMessage: error };
    }

    if (details.method !== 'upi' && details.method !== 'bank') {
      const error = `Razorpay provider cannot handle method "${details.method}" for ${affiliateCode}`;
      await logPayoutEvent(env, {
        batchId, affiliateCode, eventType: PAYOUT_EVENT.SKIPPED, provider,
        reference: null, amountCents, status: 'failure', error,
      });
      return { success: false, reference: '', errorMessage: error };
    }

    try {
      // ── Step 2: Create Contact ──
      const contactBody = {
        name: (details as UpiPayoutDetails | BankPayoutDetails).accountHolderName,
        email,
        type: 'vendor',
        reference_id: `affiliate-${affiliateCode}`,
      };

      const contact = await this.post<{ id: string }>(
        RAZORPAY_API.CONTACTS,
        contactBody,
        auth,
        this.idempotencyKey(batchId, affiliateCode, 'contact')
      );

      console.log(`[Payouts:Razorpay] Contact created: ${contact.id} for ${affiliateCode}`);
      await logPayoutEvent(env, {
        batchId, affiliateCode, eventType: PAYOUT_EVENT.CONTACT_CREATED, provider,
        reference: contact.id, amountCents, status: 'success',
      });

      // ── Step 3: Create Fund Account ──
      let fundAccountBody: Record<string, unknown>;

      if (details.method === 'upi') {
        const upi = details as UpiPayoutDetails;
        fundAccountBody = {
          contact_id: contact.id,
          account_type: 'vpa',
          vpa: { address: upi.upiId },
        };
      } else {
        const bank = details as BankPayoutDetails;
        fundAccountBody = {
          contact_id: contact.id,
          account_type: 'bank_account',
          bank_account: {
            name: bank.accountHolderName,
            ifsc: bank.ifsc,
            account_number: bank.accountNumber,
          },
        };
      }

      const fundAccount = await this.post<{ id: string }>(
        RAZORPAY_API.FUND_ACCOUNTS,
        fundAccountBody,
        auth,
        this.idempotencyKey(batchId, affiliateCode, 'fund-account')
      );

      console.log(`[Payouts:Razorpay] Fund account created: ${fundAccount.id} for ${affiliateCode}`);
      await logPayoutEvent(env, {
        batchId, affiliateCode, eventType: PAYOUT_EVENT.FUND_ACCOUNT_CREATED, provider,
        reference: fundAccount.id, amountCents, status: 'success',
      });

      // ── Step 4: Create Payout ──
      const mode = details.method === 'upi' ? 'UPI' : 'IMPS';
      const payoutBody = {
        account_number: (env as any).RAZORPAY_ACCOUNT_NUMBER ?? '',  // set in wrangler.toml vars
        fund_account_id: fundAccount.id,
        amount: amountCents,  // paise
        currency: 'INR',
        mode,
        purpose: 'payout',
        queue_if_low_balance: true,
        reference_id: `batch-${batchId}-${affiliateCode}`,
        narration: `Visibility affiliate commission batch ${batchId}`,
      };

      const payout = await this.post<{ id: string; status: string }>(
        RAZORPAY_API.PAYOUTS,
        payoutBody,
        auth,
        this.idempotencyKey(batchId, affiliateCode, 'payout')
      );

      console.log(`[Payouts:Razorpay] Payout created: ${payout.id} status=${payout.status} for ${affiliateCode}`);
      await logPayoutEvent(env, {
        batchId, affiliateCode, eventType: PAYOUT_EVENT.TRANSFER_SENT, provider,
        reference: payout.id, amountCents, status: 'success',
      });
      await logPayoutEvent(env, {
        batchId, affiliateCode, eventType: PAYOUT_EVENT.SUCCEEDED, provider,
        reference: payout.id, amountCents, status: 'success',
      });

      return { success: true, reference: payout.id };

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[Payouts:Razorpay] Error for ${affiliateCode}:`, errorMessage);
      await logPayoutEvent(env, {
        batchId, affiliateCode, eventType: PAYOUT_EVENT.FAILED, provider,
        reference: null, amountCents, status: 'failure', error: errorMessage,
      });
      return { success: false, reference: '', errorMessage };
    }
  }
}

// ─── Stripe Payout Provider ─────────────────────────────────────────────────

/**
 * Stripe Transfer provider for platform → connected account payouts.
 *
 * Uses `POST /v1/transfers` to push funds to an affiliate's Stripe
 * connected account (Standard or Express).
 *
 * Auth:  `Authorization: Bearer ${STRIPE_SECRET_KEY}`
 * Idempotency key: `Idempotency-Key` header
 *
 * NOTE: `amountCents` is treated as USD cents.
 *
 * Documentation: https://stripe.com/docs/connect/transfers
 */
class StripePayoutProvider implements PayoutProvider {
  private authHeader(env: Env): string {
    const key = (env as any).STRIPE_SECRET_KEY as string;
    return `Bearer ${key}`;
  }

  private idempotencyKey(batchId: number, affiliateCode: string): string {
    return `visibility-marketing-${batchId}-${affiliateCode}`;
  }

  async process(req: PayoutRequest, env: Env): Promise<PayoutResult> {
    const { affiliateCode, amountCents, batchId } = req;
    const provider = PAYOUT_PROVIDERS.STRIPE;

    console.log(`[Payouts:Stripe] Starting payout for ${affiliateCode} batch #${batchId} amount=${amountCents}`);

    await logPayoutEvent(env, {
      batchId, affiliateCode, eventType: PAYOUT_EVENT.INITIATED, provider,
      reference: null, amountCents, status: 'success',
    });

    // ── Step 1: Get affiliate payout details ──
    const details = await getAffiliatePayoutDetails(env, affiliateCode);
    if (!details) {
      const error = `No payout details configured for affiliate ${affiliateCode}`;
      console.warn(`[Payouts:Stripe] ${error}`);
      await logPayoutEvent(env, {
        batchId, affiliateCode, eventType: PAYOUT_EVENT.SKIPPED, provider,
        reference: null, amountCents, status: 'failure', error,
      });
      return { success: false, reference: '', errorMessage: error };
    }

    if (details.method !== 'stripe') {
      const error = `Stripe provider cannot handle method "${details.method}" for ${affiliateCode}`;
      await logPayoutEvent(env, {
        batchId, affiliateCode, eventType: PAYOUT_EVENT.SKIPPED, provider,
        reference: null, amountCents, status: 'failure', error,
      });
      return { success: false, reference: '', errorMessage: error };
    }

    const stripeDetails = details as StripePayoutDetails;

    try {
      // Build x-www-form-urlencoded body (Stripe REST API format)
      const params = new URLSearchParams({
        amount: String(amountCents),
        currency: 'usd',
        destination: stripeDetails.stripeAccountId,
        'metadata[batch_id]': String(batchId),
        'metadata[affiliate_code]': affiliateCode,
        'metadata[source]': 'visibility-marketing',
      });

      const response = await withRetry(() =>
        fetch(STRIPE_API.TRANSFERS, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': this.authHeader(env),
            'Idempotency-Key': this.idempotencyKey(batchId, affiliateCode),
            'Stripe-Version': '2024-06-20',
          },
          body: params.toString(),
        })
      );

      if (!response.ok) {
        const errorBody = await response.text().catch(() => response.statusText);
        throw new Error(`Stripe transfer failed [${response.status}]: ${errorBody}`);
      }

      const transfer = await response.json() as { id: string; amount: number; destination: string };

      console.log(`[Payouts:Stripe] Transfer created: ${transfer.id} for ${affiliateCode}`);
      await logPayoutEvent(env, {
        batchId, affiliateCode, eventType: PAYOUT_EVENT.TRANSFER_SENT, provider,
        reference: transfer.id, amountCents, status: 'success',
      });
      await logPayoutEvent(env, {
        batchId, affiliateCode, eventType: PAYOUT_EVENT.SUCCEEDED, provider,
        reference: transfer.id, amountCents, status: 'success',
      });

      return { success: true, reference: transfer.id };

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[Payouts:Stripe] Error for ${affiliateCode}:`, errorMessage);
      await logPayoutEvent(env, {
        batchId, affiliateCode, eventType: PAYOUT_EVENT.FAILED, provider,
        reference: null, amountCents, status: 'failure', error: errorMessage,
      });
      return { success: false, reference: '', errorMessage };
    }
  }
}

// ─── Provider Registry ──────────────────────────────────────────────────────

const providers: Record<string, PayoutProvider> = {
  [PAYOUT_PROVIDERS.STUB]: new StubPayoutProvider(),
  [PAYOUT_PROVIDERS.RAZORPAY]: new RazorpayPayoutProvider(),
  [PAYOUT_PROVIDERS.STRIPE]: new StripePayoutProvider(),
};

/**
 * Resolve the active payout provider from the environment.
 * Defaults to the stub if `PAYOUT_PROVIDER` is not set or unknown.
 */
export function getPayoutProvider(env: Env): PayoutProvider {
  const name = (env as any).PAYOUT_PROVIDER ?? PAYOUT_PROVIDERS.STUB;
  const provider = providers[name as string];
  if (!provider) {
    console.warn(`[Payouts] Unknown provider "${name}", falling back to stub`);
    return providers[PAYOUT_PROVIDERS.STUB];
  }
  return provider;
}

/**
 * Convenience wrapper — process a single payout using the active provider.
 * All errors are caught and returned as a failed `PayoutResult`.
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
    console.error(`[Payouts] Unhandled provider error for ${req.affiliateCode}:`, errorMessage);
    return { success: false, reference: '', errorMessage };
  }
}

// ─── Re-export HMAC helper for potential reuse ──────────────────────────────

export { hmacSha256 };
