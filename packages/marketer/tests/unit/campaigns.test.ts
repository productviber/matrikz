/**
 * Campaign Route Tests
 *
 * Tests for campaign CRUD, referral redirects, UTM parameter handling,
 * and slug generation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleCreateCampaign,
  handleListCampaigns,
  handleGetCampaign,
  handleReferralRedirect,
  handleUpdateCampaign,
} from '../../src/routes/campaigns';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';
import { UTM_DEFAULTS, BASE_URL } from '../../src/constants';

describe('campaigns routes', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
    // No default handlers — each test registers what it needs.
    // Unmatched queries return [] / null by default in MockD1Database.
  });

  function adminRequest(method: string, path: string, body?: unknown): Request {
    return makeRequest(method, path, body, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
  }

  // ─── Create Campaign ─────────────────────────────────────────────────

  // Auth is enforced centrally by resolveRouteLane() in index.ts

  describe('handleCreateCampaign()', () => {
    it('requires name field', async () => {
      const req = adminRequest('POST', '/api/campaigns', {});
      const res = await handleCreateCampaign(req, env as any);
      expect(res.status).toBe(400);
    });

    it('creates campaign with defaults', async () => {
      env.DB.onQuery(/SELECT \* FROM campaigns WHERE slug/, () => [
        {
          id: 1,
          name: 'Spring Sale',
          slug: 'spring-sale',
          affiliate_code: null,
          utm_source: UTM_DEFAULTS.SOURCE,
          utm_medium: UTM_DEFAULTS.MEDIUM,
          utm_campaign: 'spring-sale',
          utm_content: null,
          utm_term: null,
          destination_url: BASE_URL,
          clicks: 0,
          conversions: 0,
          is_active: 1,
          created_at: 1700000000,
          updated_at: 1700000000,
        },
      ]);

      const req = adminRequest('POST', '/api/campaigns', { name: 'Spring Sale' });
      const res = await handleCreateCampaign(req, env as any);
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.data.slug).toBe('spring-sale');
      expect(body.data.referralUrl).toContain(UTM_DEFAULTS.SOURCE);
    });

    it('rejects duplicate slugs', async () => {
      // Return existing campaign for slug check
      env.DB.onQuery(/SELECT id FROM campaigns WHERE slug/, () => [{ id: 1 }]);

      const req = adminRequest('POST', '/api/campaigns', { name: 'Existing' });
      const res = await handleCreateCampaign(req, env as any);
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toContain('already exists');
    });
  });

  // ─── List Campaigns ───────────────────────────────────────────────────

  describe('handleListCampaigns()', () => {
    it('returns empty list when no campaigns', async () => {
      const req = adminRequest('GET', '/api/campaigns');
      const res = await handleListCampaigns(req, env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.campaigns).toEqual([]);
    });

    it('returns campaigns with referral URLs', async () => {
      env.DB.onQuery(/SELECT \* FROM campaigns\b/, () => [
        {
          id: 1,
          name: 'Test',
          slug: 'test',
          affiliate_code: 'aff-1',
          utm_source: 'affiliate',
          utm_medium: 'referral',
          utm_campaign: 'test',
          utm_content: null,
          utm_term: null,
          destination_url: BASE_URL,
          clicks: 100,
          conversions: 10,
          is_active: 1,
        },
      ]);

      const req = adminRequest('GET', '/api/campaigns');
      const res = await handleListCampaigns(req, env as any);
      const body = await res.json() as any;
      expect(body.data.campaigns).toHaveLength(1);
      expect(body.data.campaigns[0].referralUrl).toContain('utm_source=affiliate');
      expect(body.data.campaigns[0].conversionRate).toBe('10.0%');
    });

    it('filters by affiliate code', async () => {
      const req = adminRequest('GET', '/api/campaigns?affiliate=aff-1');
      const res = await handleListCampaigns(req, env as any);
      expect(res.status).toBe(200);

      const affQuery = env.DB._queries.find(q => q.params.includes('aff-1'));
      expect(affQuery).toBeDefined();
    });

    it('supports pagination', async () => {
      const req = adminRequest('GET', '/api/campaigns?page=2&limit=10');
      const res = await handleListCampaigns(req, env as any);
      const body = await res.json() as any;
      expect(body.data.page).toBe(2);
      expect(body.data.limit).toBe(10);
    });
  });

  // ─── Get Campaign ────────────────────────────────────────────────────

  describe('handleGetCampaign()', () => {
    it('returns 404 for non-existent campaign', async () => {
      const req = adminRequest('GET', '/api/campaigns/nonexistent');
      const res = await handleGetCampaign(req, env as any, 'nonexistent');
      expect(res.status).toBe(404);
    });

    it('returns campaign with conversion rate', async () => {
      env.DB.onQuery(/SELECT \* FROM campaigns WHERE slug/, () => [
        {
          id: 1,
          name: 'Test',
          slug: 'test',
          affiliate_code: null,
          utm_source: 'affiliate',
          utm_medium: 'referral',
          utm_campaign: 'test',
          utm_content: null,
          utm_term: null,
          destination_url: BASE_URL,
          clicks: 200,
          conversions: 30,
          is_active: 1,
        },
      ]);

      const req = adminRequest('GET', '/api/campaigns/test');
      const res = await handleGetCampaign(req, env as any, 'test');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.conversionRate).toBe('15.0%');
    });

    it('shows 0.0% rate when no clicks', async () => {
      env.DB.onQuery(/SELECT \* FROM campaigns WHERE slug/, () => [
        {
          id: 1, name: 'New', slug: 'new', affiliate_code: null,
          utm_source: 'affiliate', utm_medium: 'referral', utm_campaign: 'new',
          utm_content: null, utm_term: null, destination_url: BASE_URL,
          clicks: 0, conversions: 0, is_active: 1,
        },
      ]);

      const req = adminRequest('GET', '/api/campaigns/new');
      const res = await handleGetCampaign(req, env as any, 'new');
      const body = await res.json() as any;
      expect(body.data.conversionRate).toBe('0.0%');
    });
  });

  // ─── Referral Redirect ────────────────────────────────────────────────

  describe('handleReferralRedirect()', () => {
    it('redirects to base URL with ref when campaign not found', async () => {
      const req = makeRequest('GET', '/r/unknown-slug');
      const res = await handleReferralRedirect(req, env as any, 'unknown-slug');
      expect(res.status).toBe(302);
      const location = res.headers.get('Location');
      expect(location).toContain(BASE_URL);
      expect(location).toContain('ref=unknown-slug');
    });

    it('redirects to campaign URL with UTM params', async () => {
      env.DB.onQuery(/SELECT \* FROM campaigns WHERE slug.*is_active/, () => [
        {
          id: 1, name: 'Sale', slug: 'sale', affiliate_code: 'aff-1',
          utm_source: 'affiliate', utm_medium: 'referral', utm_campaign: 'sale',
          utm_content: null, utm_term: null, destination_url: BASE_URL,
          clicks: 0, conversions: 0, is_active: 1,
        },
      ]);

      const req = makeRequest('GET', '/r/sale');
      const res = await handleReferralRedirect(req, env as any, 'sale');
      expect(res.status).toBe(302);
      const location = res.headers.get('Location')!;
      expect(location).toContain('utm_source=affiliate');
      expect(location).toContain('utm_medium=referral');
      expect(location).toContain('ref=aff-1');
    });

    it('sets affiliate attribution cookie', async () => {
      env.DB.onQuery(/SELECT \* FROM campaigns WHERE slug.*is_active/, () => [
        {
          id: 1, name: 'Ref', slug: 'ref', affiliate_code: 'aff-cookie',
          utm_source: 'affiliate', utm_medium: 'referral', utm_campaign: 'ref',
          utm_content: null, utm_term: null, destination_url: BASE_URL,
          clicks: 0, conversions: 0, is_active: 1,
        },
      ]);

      const req = makeRequest('GET', '/r/ref');
      const res = await handleReferralRedirect(req, env as any, 'ref');
      const cookie = res.headers.get('Set-Cookie');
      expect(cookie).toContain('aff-cookie');
      expect(cookie).toContain('SameSite=Lax');
    });
  });

  // ─── Update Campaign ──────────────────────────────────────────────────

  describe('handleUpdateCampaign()', () => {
    it('returns 404 for non-existent campaign', async () => {
      const req = adminRequest('PUT', '/api/campaigns/nonexistent', { name: 'Updated' });
      const res = await handleUpdateCampaign(req, env as any, 'nonexistent');
      expect(res.status).toBe(404);
    });

    it('rejects empty updates', async () => {
      env.DB.onQuery(/SELECT \* FROM campaigns WHERE slug/, () => [
        {
          id: 1, name: 'Test', slug: 'test', affiliate_code: null,
          utm_source: 'affiliate', utm_medium: 'referral', utm_campaign: 'test',
          utm_content: null, utm_term: null, destination_url: BASE_URL,
          clicks: 0, conversions: 0, is_active: 1,
        },
      ]);

      const req = adminRequest('PUT', '/api/campaigns/test', {});
      const res = await handleUpdateCampaign(req, env as any, 'test');
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toContain('No valid fields');
    });

    it('updates campaign fields', async () => {
      env.DB.onQuery(/SELECT \* FROM campaigns WHERE slug/, () => [
        {
          id: 1, name: 'Old Name', slug: 'test', affiliate_code: null,
          utm_source: 'affiliate', utm_medium: 'referral', utm_campaign: 'test',
          utm_content: null, utm_term: null, destination_url: BASE_URL,
          clicks: 0, conversions: 0, is_active: 1,
        },
      ]);

      const req = adminRequest('PUT', '/api/campaigns/test', {
        name: 'New Name',
        isActive: false,
      });
      const res = await handleUpdateCampaign(req, env as any, 'test');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.updated).toBe(true);
    });
  });
});
