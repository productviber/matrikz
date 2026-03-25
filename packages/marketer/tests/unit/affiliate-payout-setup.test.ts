/**
 * Affiliate Payout Setup Route Tests
 *
 * Tests for PUT /api/affiliate/:code/payout-details (set payout method)
 * and GET /api/affiliate/:code/payout-details (retrieve payout method).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleSetAffiliatePayoutDetails,
  handleGetAffiliatePayoutDetails,
} from '../../src/routes/affiliate-payout-setup';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';
import { KV_PREFIX } from '../../src/constants';

describe('affiliate-payout-setup routes', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
  });

  function adminRequest(method: string, path: string, body?: unknown): Request {
    return makeRequest(method, path, body, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
  }

  async function seedAffiliate(code: string, email: string): Promise<void> {
    await env.KV_MARKETING.put(`${KV_PREFIX.AFFILIATE_EMAIL}${code}`, email);
  }

  // Auth is enforced centrally by resolveRouteLane() in index.ts

  // ─── 404 when affiliate not found ───────────────────────────────────

  describe('affiliate not found', () => {
    it('PUT returns 404 for unknown affiliate', async () => {
      const req = adminRequest('PUT', '/api/affiliate/ghost/payout-details', {
        method: 'upi',
        upiId: 'x@upi',
        accountHolderName: 'X',
      });
      const res = await handleSetAffiliatePayoutDetails(req, env as any, 'ghost');
      expect(res.status).toBe(404);
    });

    it('GET returns 404 for unknown affiliate', async () => {
      const req = adminRequest('GET', '/api/affiliate/ghost/payout-details');
      const res = await handleGetAffiliatePayoutDetails(req, env as any, 'ghost');
      expect(res.status).toBe(404);
    });
  });

  // ─── Validation ─────────────────────────────────────────────────────

  describe('input validation', () => {
    beforeEach(async () => {
      await seedAffiliate('aff-1', 'test@example.com');
    });

    it('returns 400 for missing method', async () => {
      const req = adminRequest('PUT', '/api/affiliate/aff-1/payout-details', {});
      const res = await handleSetAffiliatePayoutDetails(req, env as any, 'aff-1');
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toContain('Invalid payout method');
    });

    it('returns 400 for unknown method', async () => {
      const req = adminRequest('PUT', '/api/affiliate/aff-1/payout-details', { method: 'paypal' });
      const res = await handleSetAffiliatePayoutDetails(req, env as any, 'aff-1');
      expect(res.status).toBe(400);
    });

    it('returns 400 for upi without upiId', async () => {
      const req = adminRequest('PUT', '/api/affiliate/aff-1/payout-details', {
        method: 'upi',
        accountHolderName: 'Test',
      });
      const res = await handleSetAffiliatePayoutDetails(req, env as any, 'aff-1');
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toContain('upiId');
    });

    it('returns 400 for bank without accountHolderName', async () => {
      const req = adminRequest('PUT', '/api/affiliate/aff-1/payout-details', {
        method: 'bank',
        ifsc: 'HDFC0001',
        accountNumber: '123',
      });
      const res = await handleSetAffiliatePayoutDetails(req, env as any, 'aff-1');
      expect(res.status).toBe(400);
    });

    it('returns 400 for bank without ifsc', async () => {
      const req = adminRequest('PUT', '/api/affiliate/aff-1/payout-details', {
        method: 'bank',
        accountHolderName: 'Test',
        accountNumber: '123',
      });
      const res = await handleSetAffiliatePayoutDetails(req, env as any, 'aff-1');
      expect(res.status).toBe(400);
    });

    it('returns 400 for stripe without stripeAccountId', async () => {
      const req = adminRequest('PUT', '/api/affiliate/aff-1/payout-details', {
        method: 'stripe',
      });
      const res = await handleSetAffiliatePayoutDetails(req, env as any, 'aff-1');
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toContain('stripeAccountId');
    });

    it('returns 400 for invalid JSON body', async () => {
      const req = new Request('https://test.workers.dev/api/affiliate/aff-1/payout-details', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.ADMIN_TOKEN}`,
        },
        body: 'not-json',
      });
      const res = await handleSetAffiliatePayoutDetails(req, env as any, 'aff-1');
      expect(res.status).toBe(400);
    });
  });

  // ─── UPI happy path ─────────────────────────────────────────────────

  describe('PUT with UPI details', () => {
    beforeEach(async () => {
      await seedAffiliate('aff-upi', 'upi@example.com');
    });

    it('saves UPI details and returns 200', async () => {
      const req = adminRequest('PUT', '/api/affiliate/aff-upi/payout-details', {
        method: 'upi',
        upiId: 'alice@oksbi',
        accountHolderName: 'Alice',
      });
      const res = await handleSetAffiliatePayoutDetails(req, env as any, 'aff-upi');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.method).toBe('upi');
    });

    it('persists UPI details to KV', async () => {
      const req = adminRequest('PUT', '/api/affiliate/aff-upi/payout-details', {
        method: 'upi',
        upiId: 'alice@oksbi',
        accountHolderName: 'Alice',
      });
      await handleSetAffiliatePayoutDetails(req, env as any, 'aff-upi');
      const stored = await env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_PAYOUT_DETAILS}aff-upi`);
      const parsed = JSON.parse(stored!);
      expect(parsed.method).toBe('upi');
      expect(parsed.upiId).toBe('alice@oksbi');
    });

    it('uppercases nothing — preserves upiId as-is', async () => {
      const req = adminRequest('PUT', '/api/affiliate/aff-upi/payout-details', {
        method: 'upi',
        upiId: '  user@paytm  ',
        accountHolderName: 'Bob',
      });
      await handleSetAffiliatePayoutDetails(req, env as any, 'aff-upi');
      const stored = JSON.parse(await env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_PAYOUT_DETAILS}aff-upi`) ?? '{}');
      expect(stored.upiId).toBe('user@paytm');  // trimmed
    });

    it('writes an audit note to D1', async () => {
      const req = adminRequest('PUT', '/api/affiliate/aff-upi/payout-details', {
        method: 'upi',
        upiId: 'alice@oksbi',
        accountHolderName: 'Alice',
      });
      await handleSetAffiliatePayoutDetails(req, env as any, 'aff-upi');
      const insertQuery = env.DB._queries.find((q: any) =>
        q.sql.includes('INSERT INTO affiliate_notes')
      );
      expect(insertQuery).toBeDefined();
    });
  });

  // ─── Bank happy path ─────────────────────────────────────────────────

  describe('PUT with bank details', () => {
    beforeEach(async () => {
      await seedAffiliate('aff-bank', 'bank@example.com');
    });

    it('saves bank details and uppercases IFSC', async () => {
      const req = adminRequest('PUT', '/api/affiliate/aff-bank/payout-details', {
        method: 'bank',
        accountHolderName: 'Corp',
        ifsc: 'hdfc0001234',
        accountNumber: '987654321',
      });
      const res = await handleSetAffiliatePayoutDetails(req, env as any, 'aff-bank');
      expect(res.status).toBe(200);
      const stored = JSON.parse(await env.KV_MARKETING.get(`${KV_PREFIX.AFFILIATE_PAYOUT_DETAILS}aff-bank`) ?? '{}');
      expect(stored.ifsc).toBe('HDFC0001234');
    });
  });

  // ─── Stripe happy path ─────────────────────────────────────────────

  describe('PUT with stripe details', () => {
    beforeEach(async () => {
      await seedAffiliate('aff-stripe', 'stripe@example.com');
    });

    it('saves stripe account ID', async () => {
      const req = adminRequest('PUT', '/api/affiliate/aff-stripe/payout-details', {
        method: 'stripe',
        stripeAccountId: 'acct_1TestXYZ',
      });
      const res = await handleSetAffiliatePayoutDetails(req, env as any, 'aff-stripe');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.method).toBe('stripe');
    });
  });

  // ─── GET payout details ─────────────────────────────────────────────

  describe('GET payout details', () => {
    beforeEach(async () => {
      await seedAffiliate('aff-get', 'get@example.com');
    });

    it('returns 404 when no details yet', async () => {
      const req = adminRequest('GET', '/api/affiliate/aff-get/payout-details');
      const res = await handleGetAffiliatePayoutDetails(req, env as any, 'aff-get');
      expect(res.status).toBe(404);
    });

    it('retrieves UPI details with masked upiId', async () => {
      await env.KV_MARKETING.put(
        `${KV_PREFIX.AFFILIATE_PAYOUT_DETAILS}aff-get`,
        JSON.stringify({ method: 'upi', upiId: 'alice@oksbi', accountHolderName: 'Alice' })
      );
      const req = adminRequest('GET', '/api/affiliate/aff-get/payout-details');
      const res = await handleGetAffiliatePayoutDetails(req, env as any, 'aff-get');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.method).toBe('upi');
      // upiId should be masked
      expect(body.data.upiId).toContain('***');
      expect(body.data.upiId).toContain('@oksbi');
    });

    it('retrieves bank details with masked account number', async () => {
      await env.KV_MARKETING.put(
        `${KV_PREFIX.AFFILIATE_PAYOUT_DETAILS}aff-get`,
        JSON.stringify({
          method: 'bank',
          accountHolderName: 'Corp',
          ifsc: 'HDFC0001234',
          accountNumber: '12345678',
        })
      );
      const req = adminRequest('GET', '/api/affiliate/aff-get/payout-details');
      const res = await handleGetAffiliatePayoutDetails(req, env as any, 'aff-get');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.accountNumber).toContain('5678');  // last 4 visible
      expect(body.data.accountNumber.startsWith('*')).toBe(true);
    });

    it('retrieves stripe details unmasked', async () => {
      await env.KV_MARKETING.put(
        `${KV_PREFIX.AFFILIATE_PAYOUT_DETAILS}aff-get`,
        JSON.stringify({ method: 'stripe', stripeAccountId: 'acct_abc123' })
      );
      const req = adminRequest('GET', '/api/affiliate/aff-get/payout-details');
      const res = await handleGetAffiliatePayoutDetails(req, env as any, 'aff-get');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.stripeAccountId).toBe('acct_abc123');
    });
  });
});
