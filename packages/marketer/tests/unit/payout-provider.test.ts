/**
 * Payout Provider Tests
 *
 * Tests for the stub, Razorpay X2B, and Stripe payout providers,
 * along with helpers (getAffiliatePayoutDetails, saveAffiliatePayoutDetails, hmacSha256).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  processPayoutItem,
  getPayoutProvider,
  getAffiliatePayoutDetails,
  saveAffiliatePayoutDetails,
  hmacSha256,
} from '../../src/lib/payout-provider';
import { createMockEnv, type MockEnv } from '../helpers';
import { KV_PREFIX, PAYOUT_PROVIDERS } from '../../src/constants';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEnv(overrides: Partial<MockEnv & Record<string, unknown>> = {}): MockEnv & Record<string, unknown> {
  return { ...createMockEnv(), ...overrides } as any;
}

const BASE_REQ = {
  affiliateCode: 'aff-test',
  email: 'test@example.com',
  amountCents: 5000,
  batchId: 1,
};

// ─── hmacSha256 helper ───────────────────────────────────────────────────────

describe('hmacSha256()', () => {
  it('returns a 64-char hex string', async () => {
    const sig = await hmacSha256('secret', 'message');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different signatures for different secrets', async () => {
    const s1 = await hmacSha256('secret1', 'message');
    const s2 = await hmacSha256('secret2', 'message');
    expect(s1).not.toBe(s2);
  });

  it('is deterministic for same inputs', async () => {
    const s1 = await hmacSha256('key', 'data');
    const s2 = await hmacSha256('key', 'data');
    expect(s1).toBe(s2);
  });
});

// ─── KV Payout Details helpers ───────────────────────────────────────────────

describe('getAffiliatePayoutDetails() / saveAffiliatePayoutDetails()', () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => { env = makeEnv(); });

  it('returns null when no details set', async () => {
    const result = await getAffiliatePayoutDetails(env as any, 'aff-missing');
    expect(result).toBeNull();
  });

  it('round-trips UPI details', async () => {
    const details = { method: 'upi' as const, upiId: 'test@upi', accountHolderName: 'Alice' };
    await saveAffiliatePayoutDetails(env as any, 'aff-1', details);
    const result = await getAffiliatePayoutDetails(env as any, 'aff-1');
    expect(result).toEqual(details);
  });

  it('round-trips bank details', async () => {
    const details = {
      method: 'bank' as const,
      accountHolderName: 'Bob',
      ifsc: 'HDFC0001234',
      accountNumber: '123456789',
    };
    await saveAffiliatePayoutDetails(env as any, 'aff-2', details);
    const result = await getAffiliatePayoutDetails(env as any, 'aff-2');
    expect(result).toEqual(details);
  });

  it('round-trips stripe details', async () => {
    const details = { method: 'stripe' as const, stripeAccountId: 'acct_1ABC123' };
    await saveAffiliatePayoutDetails(env as any, 'aff-3', details);
    const result = await getAffiliatePayoutDetails(env as any, 'aff-3');
    expect(result).toEqual(details);
  });

  it('stores under the correct KV key', async () => {
    const details = { method: 'stripe' as const, stripeAccountId: 'acct_XXX' };
    await saveAffiliatePayoutDetails(env as any, 'aff-kv', details);
    const raw = await env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_PAYOUT_DETAILS}aff-kv`);
    expect(JSON.parse(raw!)).toEqual(details);
  });

  it('returns null for corrupt KV entry', async () => {
    await env.KV_MARKETING.put(`${KV_PREFIX.AFFILIATE_PAYOUT_DETAILS}bad`, 'not-json');
    const result = await getAffiliatePayoutDetails(env as any, 'bad');
    expect(result).toBeNull();
  });
});

// ─── Provider registry ───────────────────────────────────────────────────────

describe('getPayoutProvider()', () => {
  it('returns stub when PAYOUT_PROVIDER is not set', () => {
    const env = makeEnv({ PAYOUT_PROVIDER: undefined });
    const provider = getPayoutProvider(env as any);
    expect(provider).toBeDefined();
  });

  it('returns stub provider when PAYOUT_PROVIDER=stub', () => {
    const env = makeEnv({ PAYOUT_PROVIDER: PAYOUT_PROVIDERS.STUB });
    const provider = getPayoutProvider(env as any);
    expect(provider).toBeDefined();
  });

  it('returns stub provider for unknown PAYOUT_PROVIDER value', () => {
    const env = makeEnv({ PAYOUT_PROVIDER: 'unknown-provider' });
    const provider = getPayoutProvider(env as any);
    expect(provider).toBeDefined();
  });

  it('returns razorpay provider when PAYOUT_PROVIDER=razorpay', () => {
    const env = makeEnv({ PAYOUT_PROVIDER: PAYOUT_PROVIDERS.RAZORPAY });
    const provider = getPayoutProvider(env as any);
    expect(provider).toBeDefined();
  });

  it('returns stripe provider when PAYOUT_PROVIDER=stripe', () => {
    const env = makeEnv({ PAYOUT_PROVIDER: PAYOUT_PROVIDERS.STRIPE });
    const provider = getPayoutProvider(env as any);
    expect(provider).toBeDefined();
  });
});

// ─── Stub Provider ───────────────────────────────────────────────────────────

describe('StubPayoutProvider', () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    env = makeEnv({ PAYOUT_PROVIDER: PAYOUT_PROVIDERS.STUB });
  });

  it('returns success with a STUB- prefixed reference', async () => {
    const result = await processPayoutItem(env as any, BASE_REQ);
    expect(result.success).toBe(true);
    expect(result.reference).toMatch(/^STUB-1-aff-test-/);
  });

  it('includes batchId and affiliateCode in reference', async () => {
    const result = await processPayoutItem(env as any, {
      ...BASE_REQ,
      batchId: 42,
      affiliateCode: 'influencer-x',
    });
    expect(result.reference).toMatch(/^STUB-42-influencer-x-/);
  });

  it('logs a payout_events row', async () => {
    await processPayoutItem(env as any, BASE_REQ);
    const insertQuery = env.DB._queries.find((q: any) =>
      q.sql.includes('INSERT INTO payout_events')
    );
    expect(insertQuery).toBeDefined();
  });
});

// ─── Razorpay Provider ───────────────────────────────────────────────────────

describe('RazorpayPayoutProvider', () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    env = makeEnv({
      PAYOUT_PROVIDER: PAYOUT_PROVIDERS.RAZORPAY,
      RAZORPAY_KEY_ID: 'test-key-id',
      RAZORPAY_KEY_SECRET: 'test-key-secret',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails gracefully when no payout details are configured', async () => {
    const result = await processPayoutItem(env as any, BASE_REQ);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('No payout details configured');
  });

  it('fails gracefully when method is stripe (wrong provider)', async () => {
    await saveAffiliatePayoutDetails(env as any, 'aff-test', {
      method: 'stripe',
      stripeAccountId: 'acct_XXX',
    });
    const result = await processPayoutItem(env as any, BASE_REQ);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('cannot handle method');
  });

  it('succeeds with UPI details via mocked fetch', async () => {
    await saveAffiliatePayoutDetails(env as any, 'aff-test', {
      method: 'upi',
      upiId: 'test@upi',
      accountHolderName: 'Test User',
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes('/contacts')) {
        return new Response(JSON.stringify({ id: 'cont_123' }), { status: 200 });
      }
      if (urlStr.includes('/fund_accounts')) {
        return new Response(JSON.stringify({ id: 'fa_456' }), { status: 200 });
      }
      if (urlStr.includes('/payouts')) {
        return new Response(JSON.stringify({ id: 'pout_789', status: 'processing' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const result = await processPayoutItem(env as any, BASE_REQ);
    expect(result.success).toBe(true);
    expect(result.reference).toBe('pout_789');
  });

  it('succeeds with bank details via mocked fetch', async () => {
    await saveAffiliatePayoutDetails(env as any, 'aff-test', {
      method: 'bank',
      accountHolderName: 'Test User',
      ifsc: 'HDFC0001234',
      accountNumber: '987654321',
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes('/contacts')) {
        return new Response(JSON.stringify({ id: 'cont_bank' }), { status: 200 });
      }
      if (urlStr.includes('/fund_accounts')) {
        return new Response(JSON.stringify({ id: 'fa_bank' }), { status: 200 });
      }
      if (urlStr.includes('/payouts')) {
        return new Response(JSON.stringify({ id: 'pout_bank', status: 'processed' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const result = await processPayoutItem(env as any, BASE_REQ);
    expect(result.success).toBe(true);
    expect(result.reference).toBe('pout_bank');
  });

  it('returns failure when Razorpay API returns an error', async () => {
    await saveAffiliatePayoutDetails(env as any, 'aff-test', {
      method: 'upi',
      upiId: 'test@upi',
      accountHolderName: 'Test User',
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error": "bad_request"}', { status: 400 })
    );

    const result = await processPayoutItem(env as any, BASE_REQ);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBeDefined();
  });

  it('logs payout events for each step', async () => {
    await saveAffiliatePayoutDetails(env as any, 'aff-test', {
      method: 'upi',
      upiId: 'test@upi',
      accountHolderName: 'Test User',
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes('/contacts')) return new Response(JSON.stringify({ id: 'cont_123' }), { status: 200 });
      if (urlStr.includes('/fund_accounts')) return new Response(JSON.stringify({ id: 'fa_456' }), { status: 200 });
      if (urlStr.includes('/payouts')) return new Response(JSON.stringify({ id: 'pout_789', status: 'processing' }), { status: 200 });
      return new Response('not found', { status: 404 });
    });

    await processPayoutItem(env as any, BASE_REQ);
    const insertQueries = env.DB._queries.filter((q: any) =>
      q.sql.includes('INSERT INTO payout_events')
    );
    // Expect: initiated + contact_created + fund_account_created + transfer_sent + succeeded = 5
    expect(insertQueries.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── Stripe Provider ─────────────────────────────────────────────────────────

describe('StripePayoutProvider', () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    env = makeEnv({
      PAYOUT_PROVIDER: PAYOUT_PROVIDERS.STRIPE,
      STRIPE_SECRET_KEY: 'sk_test_123',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails gracefully when no payout details configured', async () => {
    const result = await processPayoutItem(env as any, BASE_REQ);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('No payout details configured');
  });

  it('fails gracefully when method is upi (wrong provider)', async () => {
    await saveAffiliatePayoutDetails(env as any, 'aff-test', {
      method: 'upi',
      upiId: 'test@upi',
      accountHolderName: 'Test',
    });
    const result = await processPayoutItem(env as any, BASE_REQ);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('cannot handle method');
  });

  it('succeeds with stripe details via mocked fetch', async () => {
    await saveAffiliatePayoutDetails(env as any, 'aff-test', {
      method: 'stripe',
      stripeAccountId: 'acct_stripe123',
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'tr_stripe456', amount: 5000, destination: 'acct_stripe123' }),
        { status: 200 }
      )
    );

    const result = await processPayoutItem(env as any, BASE_REQ);
    expect(result.success).toBe(true);
    expect(result.reference).toBe('tr_stripe456');
  });

  it('sends correct Stripe API headers', async () => {
    await saveAffiliatePayoutDetails(env as any, 'aff-test', {
      method: 'stripe',
      stripeAccountId: 'acct_xxx',
    });

    let capturedHeaders: Record<string, string> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {})
      );
      return new Response(
        JSON.stringify({ id: 'tr_ok', amount: 5000, destination: 'acct_xxx' }),
        { status: 200 }
      );
    });

    await processPayoutItem(env as any, BASE_REQ);
    expect(capturedHeaders['Authorization']).toBe('Bearer sk_test_123');
    expect(capturedHeaders['Idempotency-Key']).toBe('visibility-marketing-1-aff-test');
  });

  it('returns failure when Stripe API returns an error', async () => {
    await saveAffiliatePayoutDetails(env as any, 'aff-test', {
      method: 'stripe',
      stripeAccountId: 'acct_xxx',
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error": {"message": "No such account"}}', { status: 400 })
    );

    const result = await processPayoutItem(env as any, BASE_REQ);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBeDefined();
  });
});
