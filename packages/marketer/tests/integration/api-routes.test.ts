/**
 * Integration Tests — API Routes
 *
 * Tests the main fetch handler routing, authentication gates,
 * and response formats for key API endpoints.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/index';
import { createMockEnv, createMockCtx, makeRequest, type MockEnv } from '../helpers';

describe('worker fetch handler', () => {
  let env: MockEnv;
  let ctx: ReturnType<typeof createMockCtx>;

  beforeEach(() => {
    env = createMockEnv();
    ctx = createMockCtx();
  });

  // ── CORS ──────────────────────────────────────────────────────────────────

  describe('CORS', () => {
    it('returns 204 for OPTIONS preflight', async () => {
      const req = makeRequest('OPTIONS', '/api/campaigns');
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://visibility.clodo.dev');
    });
  });

  // ── Health ────────────────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns 200 with worker info', async () => {
      const req = makeRequest('GET', '/health');
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
    });
  });

  describe('GET /', () => {
    it('returns worker identifier', async () => {
      const req = makeRequest('GET', '/');
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.worker).toBe('visibility-marketing');
    });
  });

  // ── 404 ───────────────────────────────────────────────────────────────────

  describe('404 handling', () => {
    it('returns 404 for unknown routes', async () => {
      const req = makeRequest('GET', '/api/does-not-exist');
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(404);
    });
  });

  // ── Campaigns (Auth required after fix) ───────────────────────────────────

  describe('POST /api/campaigns', () => {
    it('requires authentication', async () => {
      const req = makeRequest('POST', '/api/campaigns', {
        name: 'Test Campaign',
      });
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(401);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
    });

    it('creates campaign with valid auth', async () => {
      // Mock DB to handle the INSERT and SELECT
      env.DB.onQuery(/INSERT INTO campaigns/, () => []);
      env.DB.onQuery(/SELECT \* FROM campaigns WHERE slug/, () => [
        {
          id: 1,
          name: 'Test Campaign',
          slug: 'test-campaign',
          affiliate_code: null,
          utm_source: 'affiliate',
          utm_medium: 'referral',
          utm_campaign: 'test-campaign',
          utm_content: null,
          utm_term: null,
          destination_url: 'https://visibility.clodo.dev',
          clicks: 0,
          conversions: 0,
          is_active: 1,
          created_at: 1700000000,
          updated_at: 1700000000,
        },
      ]);

      const req = makeRequest(
        'POST',
        '/api/campaigns',
        { name: 'Test Campaign' },
        { Authorization: `Bearer ${env.ADMIN_TOKEN}` }
      );
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data.slug).toBe('test-campaign');
    });
  });

  describe('PUT /api/campaigns/:slug', () => {
    it('requires authentication', async () => {
      const req = makeRequest('PUT', '/api/campaigns/test-camp', {
        name: 'Updated Name',
      });
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/campaigns', () => {
    it('returns 401 without auth', async () => {
      const req = makeRequest('GET', '/api/campaigns');
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(401);
    });

    it('lists campaigns with admin auth', async () => {
      env.DB.onQuery(/SELECT \* FROM campaigns/, () => []);
      env.DB.onQuery(/SELECT COUNT/, () => [{ 'COUNT(*)': 0 }]);

      const req = makeRequest('GET', '/api/campaigns', undefined, {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
      });
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(200);
    });
  });

  // ── Affiliate Application ────────────────────────────────────────────────

  describe('POST /api/affiliate/apply', () => {
    it('rejects applications with missing fields', async () => {
      const req = makeRequest('POST', '/api/affiliate/apply', { email: 'test@test.com' });
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(400);
    });

    it('rejects invalid email format', async () => {
      const req = makeRequest('POST', '/api/affiliate/apply', {
        email: 'not-an-email',
        name: 'Test User',
      });
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toContain('Invalid email');
    });

    it('successfully processes valid application', async () => {
      const req = makeRequest('POST', '/api/affiliate/apply', {
        email: 'affiliate@test.com',
        name: 'Jane Affiliate',
        website: 'https://jane.dev',
      });
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data.status).toBe('pending');
      expect(body.data.code).toBeTruthy();
    });
  });

  describe('POST /api/affiliate/approve', () => {
    it('requires admin auth', async () => {
      const req = makeRequest('POST', '/api/affiliate/approve', { code: 'aff-123' });
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/affiliate/applications', () => {
    it('requires admin auth', async () => {
      const req = makeRequest('GET', '/api/affiliate/applications');
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(401);
    });

    it('returns pending applications for admin', async () => {
      // Pre-populate KV with some pending applications
      await env.KV_MARKETING.put('affiliate-applications:pending', JSON.stringify(['code1']));
      await env.KV_MARKETING.put(
        'affiliate-application:code1',
        JSON.stringify({ code: 'code1', email: 'a@test.com', name: 'Test', status: 'pending' })
      );

      const req = makeRequest(
        'GET',
        '/api/affiliate/applications',
        undefined,
        { Authorization: `Bearer ${env.ADMIN_TOKEN}` }
      );
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data.applications).toHaveLength(1);
    });
  });

  // ── Payouts ──────────────────────────────────────────────────────────────

  describe('POST /api/payouts/batch', () => {
    it('requires admin auth', async () => {
      const req = makeRequest('POST', '/api/payouts/batch', {});
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(401);
    });
  });

  // ── Admin ────────────────────────────────────────────────────────────────

  describe('GET /api/admin/dashboard', () => {
    it('requires admin auth', async () => {
      const req = makeRequest('GET', '/api/admin/dashboard');
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/admin/notifications', () => {
    it('requires admin auth', async () => {
      const req = makeRequest('GET', '/api/admin/notifications');
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(401);
    });
  });

  // ── Events endpoint ──────────────────────────────────────────────────────

  describe('POST /events', () => {
    it('accepts valid event envelopes', async () => {
      const req = makeRequest(
        'POST',
        '/events',
        {
          event: 'affiliate.conversion',
          source: 'visibility-analytics',
          timestamp: new Date().toISOString(),
          data: {
            affiliateCode: 'test',
            userId: 'u@t.com',
            eventType: 'purchase',
            amountCents: 1000,
            commissionCents: 200,
            plan: 'pro',
          },
        },
        { 'cf-worker': 'visibility-analytics' }
      );
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
    });
  });
});
