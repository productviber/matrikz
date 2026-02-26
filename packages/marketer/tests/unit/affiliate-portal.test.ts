/**
 * Affiliate Portal Route Tests
 *
 * Tests for portal dashboard, stats endpoint, and affiliate verification.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleAffiliatePortal,
  handleAffiliateStats,
} from '../../src/routes/affiliate-portal';
import { createMockEnv, createMockFetcher, makeRequest, type MockEnv } from '../helpers';
import { COMMISSION_TIERS } from '../../src/types';

describe('affiliate-portal', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();

    // Default DB handlers
    env.DB.onQuery(/affiliate_notes.*note_type/, () => []);
    env.DB.onQuery(/payout_items.*WHERE affiliate_code/, () => []);
    env.DB.onQuery(/campaigns WHERE affiliate_code/, () => []);
  });

  // ─── Portal ────────────────────────────────────────────────────────────

  describe('handleAffiliatePortal()', () => {
    it('returns 400 when code is missing', async () => {
      const req = makeRequest('GET', '/api/affiliate/portal?email=test@test.com');
      const res = await handleAffiliatePortal(req, env as any);
      expect(res.status).toBe(400);
    });

    it('returns 400 when email is missing', async () => {
      const req = makeRequest('GET', '/api/affiliate/portal?code=aff-123');
      const res = await handleAffiliatePortal(req, env as any);
      expect(res.status).toBe(400);
    });

    it('returns 401 for unverified affiliate', async () => {
      // No cached email, no analytics result
      const req = makeRequest('GET', '/api/affiliate/portal?code=aff-123&email=wrong@test.com');
      const res = await handleAffiliatePortal(req, env as any);
      expect(res.status).toBe(401);
    });

    it('returns portal data for verified affiliate', async () => {
      const code = 'aff-verified';
      const email = 'verified@test.com';

      // Cache affiliate email in KV for verification
      await env.KV_MARKETING.put(`affiliate-email:${code}`, email);
      // Cache stats
      await env.KV_MARKETING.put(
        `affiliate-stats:${code}`,
        JSON.stringify({ totalConversions: 5, totalEarnedCents: 5000, lastConversionAt: '2025-01-15' })
      );

      const req = makeRequest('GET', `/api/affiliate/portal?code=${code}&email=${email}`);
      const res = await handleAffiliatePortal(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data.code).toBe(code);
      expect(body.data.totalConversions).toBe(5);
      expect(body.data.totalEarnedCents).toBe(5000);
      expect(body.data.tier).toBeDefined();
      expect(body.data.commissionRate).toBeGreaterThan(0);
    });

    it('returns default stats when no stats in KV', async () => {
      const code = 'aff-new';
      const email = 'new@test.com';

      // Cache email but no stats
      await env.KV_MARKETING.put(`affiliate-email:${code}`, email);

      const req = makeRequest('GET', `/api/affiliate/portal?code=${code}&email=${email}`);
      const res = await handleAffiliatePortal(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.totalConversions).toBe(0);
    });

    it('is case-insensitive for email verification', async () => {
      const code = 'aff-case';
      await env.KV_MARKETING.put(`affiliate-email:${code}`, 'Test@Example.COM');
      await env.KV_MARKETING.put(`affiliate-stats:${code}`, JSON.stringify({ totalConversions: 0, totalEarnedCents: 0, lastConversionAt: null }));

      const req = makeRequest('GET', `/api/affiliate/portal?code=${code}&email=test@example.com`);
      const res = await handleAffiliatePortal(req, env as any);
      expect(res.status).toBe(200);
    });
  });

  // ─── Stats ────────────────────────────────────────────────────────────

  describe('handleAffiliateStats()', () => {
    it('returns 400 when code is missing', async () => {
      const req = makeRequest('GET', '/api/affiliate/stats');
      const res = await handleAffiliateStats(req, env as any);
      expect(res.status).toBe(400);
    });

    it('returns default stats when no data in KV', async () => {
      const req = makeRequest('GET', '/api/affiliate/stats?code=new-aff');
      const res = await handleAffiliateStats(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.code).toBe('new-aff');
      expect(body.data.totalConversions).toBe(0);
      expect(body.data.totalEarnedCents).toBe(0);
      expect(body.data.tier).toBe(COMMISSION_TIERS[0].name);
      expect(body.data.commissionRate).toBe(COMMISSION_TIERS[0].rate);
    });

    it('returns actual stats from KV when available', async () => {
      await env.KV_MARKETING.put(
        'affiliate-stats:active-aff',
        JSON.stringify({ totalConversions: 55, totalEarnedCents: 75000, lastConversionAt: '2025-02-01' })
      );

      const req = makeRequest('GET', '/api/affiliate/stats?code=active-aff');
      const res = await handleAffiliateStats(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.totalConversions).toBe(55);
      expect(body.data.totalEarnedCents).toBe(75000);
      // 55 conversions = Gold tier
      expect(body.data.tier).toBe('Gold');
      expect(body.data.commissionRate).toBe(0.30);
    });
  });
});
