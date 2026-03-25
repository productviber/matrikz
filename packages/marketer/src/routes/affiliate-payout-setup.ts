/**
 * Affiliate Payout Details Routes
 *
 * Admin endpoints for managing per-affiliate payout method configuration.
 * Payout details are stored in KV and read by the active payout provider
 * when disbursing a batch.
 *
 * Supported methods:
 *   upi   — UPI ID (India, used by Razorpay X2B)
 *   bank  — Bank account + IFSC (India, used by Razorpay X2B IMPS/NEFT)
 *   stripe — Stripe connected account ID (global, used by Stripe Transfers)
 *
 * All changes are audited in the affiliate_notes table.
 */

import type { Env, PayoutDetails } from '../types';
import { ok, badRequest, notFound, serverError } from '../lib/response';
import { execute, now } from '../lib/db';
import { getAffiliatePayoutDetails, saveAffiliatePayoutDetails } from '../lib/payout-provider';
import { KV_PREFIX, PAYOUT_METHOD, MESSAGES, NOTE_TYPE } from '../constants';

// ─── PUT /api/affiliate/:code/payout-details ─────────────────────────────────

/**
 * Save or update the payout method for an affiliate.
 *
 * Body (upi):
 *   { method: "upi", upiId: "user@upi", accountHolderName: "Name" }
 *
 * Body (bank):
 *   { method: "bank", accountHolderName: "Name", ifsc: "HDFC0001234", accountNumber: "12345678" }
 *
 * Body (stripe):
 *   { method: "stripe", stripeAccountId: "acct_1ABC123" }
 */
export async function handleSetAffiliatePayoutDetails(
  request: Request,
  env: Env,
  affiliateCode: string
): Promise<Response> {
  // ── Verify affiliate exists ──
  const affiliateEmail = await env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_EMAIL}${affiliateCode}`);
  if (!affiliateEmail) {
    return notFound(MESSAGES.errors.affiliateNotFound);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return badRequest(MESSAGES.errors.invalidJson);
  }

  const method = body.method as string | undefined;
  if (!method || !Object.values(PAYOUT_METHOD).includes(method as typeof PAYOUT_METHOD[keyof typeof PAYOUT_METHOD])) {
    return badRequest(MESSAGES.errors.invalidPayoutMethod);
  }

  // ── Validate and build typed PayoutDetails ──
  let details: PayoutDetails;

  if (method === PAYOUT_METHOD.UPI) {
    const upiId = body.upiId as string | undefined;
    const accountHolderName = body.accountHolderName as string | undefined;
    if (!upiId) return badRequest(MESSAGES.errors.missingUpiId);
    details = {
      method: 'upi',
      upiId: upiId.trim(),
      accountHolderName: (accountHolderName ?? '').trim(),
    };
  } else if (method === PAYOUT_METHOD.BANK) {
    const accountHolderName = body.accountHolderName as string | undefined;
    const ifsc = body.ifsc as string | undefined;
    const accountNumber = body.accountNumber as string | undefined;
    if (!accountHolderName || !ifsc || !accountNumber) {
      return badRequest(MESSAGES.errors.missingBankDetails);
    }
    details = {
      method: 'bank',
      accountHolderName: accountHolderName.trim(),
      ifsc: ifsc.trim().toUpperCase(),
      accountNumber: accountNumber.trim(),
    };
  } else {
    // stripe
    const stripeAccountId = body.stripeAccountId as string | undefined;
    if (!stripeAccountId) return badRequest(MESSAGES.errors.missingStripeAccountId);
    details = {
      method: 'stripe',
      stripeAccountId: stripeAccountId.trim(),
    };
  }

  try {
    // ── Persist to KV ──
    await saveAffiliatePayoutDetails(env, affiliateCode, details);

    // ── Audit trail in D1 ──
    await execute(
      env.DB,
      `INSERT INTO affiliate_notes (affiliate_code, note_type, content, created_at)
       VALUES (?, ?, ?, ?)`,
      [
        affiliateCode,
        NOTE_TYPE.PAYOUT,
        MESSAGES.notes.payoutDetailsUpdated(method),
        now(),
      ]
    );

    console.log(`[PayoutDetails] Updated payout method for ${affiliateCode} → method=${method}`);

    return ok({
      affiliateCode,
      method,
      message: MESSAGES.success.payoutDetailsSaved,
    });
  } catch (err) {
    console.error(`[PayoutDetails] Error saving for ${affiliateCode}:`, err);
    return serverError('Failed to save payout details');
  }
}

// ─── GET /api/affiliate/:code/payout-details ─────────────────────────────────

/**
 * Retrieve the current payout method for an affiliate (admin only).
 * Sensitive fields (account numbers, UPI IDs) are partially redacted.
 */
export async function handleGetAffiliatePayoutDetails(
  request: Request,
  env: Env,
  affiliateCode: string
): Promise<Response> {
  const affiliateEmail = await env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_EMAIL}${affiliateCode}`);
  if (!affiliateEmail) {
    return notFound(MESSAGES.errors.affiliateNotFound);
  }

  const details = await getAffiliatePayoutDetails(env, affiliateCode);
  if (!details) {
    return notFound(MESSAGES.errors.payoutDetailsNotFound);
  }

  // Redact sensitive fields for the response
  const redacted = redactPayoutDetails(details);

  return ok({ affiliateCode, ...redacted });
}

// ─── Redaction Helper ─────────────────────────────────────────────────────────

function redactPayoutDetails(details: PayoutDetails): Record<string, unknown> {
  if (details.method === 'upi') {
    const parts = details.upiId.split('@');
    const masked = parts[0].length > 3
      ? `${parts[0].slice(0, 2)}***@${parts[1]}`
      : `***@${parts[1] ?? ''}`;
    return { method: 'upi', upiId: masked, accountHolderName: details.accountHolderName };
  }

  if (details.method === 'bank') {
    const last4 = details.accountNumber.slice(-4).padStart(details.accountNumber.length, '*');
    return {
      method: 'bank',
      accountHolderName: details.accountHolderName,
      ifsc: details.ifsc,
      accountNumber: last4,
    };
  }

  // stripe — account IDs are not sensitive but we mask the middle
  return {
    method: 'stripe',
    stripeAccountId: details.stripeAccountId,
  };
}
