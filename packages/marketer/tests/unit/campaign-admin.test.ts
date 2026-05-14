/**
 * Campaign Admin Endpoint Tests
 *
 * Tests for outbound campaign CRUD: list, get, create, start, pause.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleListOutboundCampaigns,
  handleGetOutboundCampaign,
  handleCreateOutboundCampaign,
  handleStartOutboundCampaign,
  handlePauseOutboundCampaign,
} from '../../src/routes/admin';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';

describe('Campaign Admin Endpoints', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
  });

  const adminHeaders = { Authorization: 'Bearer test-admin-token' };
  const noAuthHeaders = {};

  // Auth is enforced centrally by resolveRouteLane() in index.ts

  // ─── List campaigns ────────────────────────────────────────────────

  describe('handleListOutboundCampaigns()', () => {
    it('returns campaigns array', async () => {
      env.DB.onQuery(/SELECT.*outbound_campaigns/, () => [
        {
          id: 1,
          name: 'Cold Outreach v1',
          slug: 'cold-outreach-v1',
          status: 'draft',
          daily_limit: 10,
          total_sent: 0,
          source_filter: '{"sources":["hackernews"],"min_score":50}',
          channels_json: '["email","push","whatsapp"]',
          fallback_chain_json: '["email","push","whatsapp"]',
          created_at: 1700000000,
          updated_at: 1700000000,
        },
      ]);

      const req = makeRequest('GET', '/api/admin/campaigns/outbound', null, adminHeaders);
      const res = await handleListOutboundCampaigns(req, env as any);
      const body = await res.json() as any;

      expect(res.status).toBe(200);
      expect(body.data.campaigns).toHaveLength(1);
      expect(body.data.campaigns[0].slug).toBe('cold-outreach-v1');
      expect(body.data.campaigns[0].sourceFilter).toEqual({ sources: ['hackernews'], min_score: 50 });
      expect(body.data.campaigns[0].channels).toEqual(['email', 'push', 'whatsapp']);
      expect(body.data.campaigns[0].fallbackChain).toEqual(['email', 'push', 'whatsapp']);
    });

    it('includes throttle info', async () => {
      env.DB.onQuery(/SELECT.*outbound_campaigns/, () => []);

      const req = makeRequest('GET', '/api/admin/campaigns/outbound', null, adminHeaders);
      const res = await handleListOutboundCampaigns(req, env as any);
      const body = await res.json() as any;

      expect(body.data.throttle).toBeDefined();
      expect(body.data.throttle.sentToday).toBe(0);
      expect(body.data.throttle.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  // ─── Get campaign ─────────────────────────────────────────────────

  describe('handleGetOutboundCampaign()', () => {
    it('returns 404 for non-existent campaign', async () => {
      env.DB.onQuery(/SELECT.*outbound_campaigns.*WHERE id/, () => []);

      const req = makeRequest('GET', '/api/admin/campaigns/outbound/999', null, adminHeaders);
      const res = await handleGetOutboundCampaign(req, env as any, 999);

      expect(res.status).toBe(404);
    });

    it('returns campaign with throttle info', async () => {
      env.DB.onQuery(/SELECT.*outbound_campaigns.*WHERE id/, () => [
        {
          id: 1,
          name: 'Cold Outreach v1',
          slug: 'cold-outreach-v1',
          sequence_id: 1,
          status: 'active',
          daily_limit: 10,
          source_filter: null,
          channels_json: '["email","push"]',
          fallback_chain_json: '["email","push"]',
          total_sent: 5,
          warmup_day: 3,
          started_at: 1700000000,
          created_at: 1700000000,
          updated_at: 1700000000,
        },
      ]);
      // Send stats query — matches email_sends grouped by status
      env.DB.onQuery(/SELECT[\s\S]*COUNT[\s\S]*email_sends/, () => [
        { status: 'sent', count: 3 },
        { status: 'scheduled', count: 2 },
      ]);

      const req = makeRequest('GET', '/api/admin/campaigns/outbound/1', null, adminHeaders);
      const res = await handleGetOutboundCampaign(req, env as any, 1);
      const body = await res.json() as any;

      expect(res.status).toBe(200);
      expect(body.data.campaign.name).toBe('Cold Outreach v1');
      expect(body.data.campaign.channels).toEqual(['email', 'push']);
      expect(body.data.campaign.fallbackChain).toEqual(['email', 'push']);
      expect(body.data.throttle).toBeDefined();
      expect(body.data.sendsByStatus.sent).toBe(3);
    });
  });

  // ─── Create campaign ──────────────────────────────────────────────

  describe('handleCreateOutboundCampaign()', () => {
    it('rejects request without name', async () => {
      const req = makeRequest('POST', '/api/admin/campaigns/outbound', { slug: 'test' }, adminHeaders);
      const res = await handleCreateOutboundCampaign(req, env as any);
      expect(res.status).toBe(400);
    });

    it('rejects request without slug', async () => {
      const req = makeRequest('POST', '/api/admin/campaigns/outbound', { name: 'Test' }, adminHeaders);
      const res = await handleCreateOutboundCampaign(req, env as any);
      expect(res.status).toBe(400);
    });

    it('rejects invalid slug format', async () => {
      const req = makeRequest('POST', '/api/admin/campaigns/outbound', {
        name: 'Test', slug: 'BAD SLUG!'
      }, adminHeaders);
      const res = await handleCreateOutboundCampaign(req, env as any);
      expect(res.status).toBe(400);
    });

    it('rejects duplicate slug', async () => {
      env.DB.onQuery(/SELECT.*outbound_campaigns.*WHERE slug/, () => [{ id: 1 }]);

      const req = makeRequest('POST', '/api/admin/campaigns/outbound', {
        name: 'Test', slug: 'existing-slug'
      }, adminHeaders);
      const res = await handleCreateOutboundCampaign(req, env as any);
      expect(res.status).toBe(400);
    });

    it('creates campaign with valid data', async () => {
      // No existing campaign with this slug
      env.DB.onQuery(/SELECT.*outbound_campaigns.*WHERE slug/, () => []);
      // Return created campaign on second SELECT
      let selectCount = 0;
      env.DB.onQuery(/SELECT.*outbound_campaigns/, (params) => {
        selectCount++;
        if (selectCount <= 1) return []; // uniqueness check
        return [{
          id: 2,
          name: 'My Campaign',
          slug: 'my-campaign',
          status: 'draft',
          daily_limit: 10,
          created_at: 1700000000,
        }];
      });

      const req = makeRequest('POST', '/api/admin/campaigns/outbound', {
        name: 'My Campaign',
        slug: 'my-campaign',
        daily_limit: 10,
        channels: ['email', 'push', 'whatsapp'],
        fallback_chain: ['email', 'push', 'whatsapp'],
      }, adminHeaders);
      const res = await handleCreateOutboundCampaign(req, env as any);

      expect(res.status).toBe(201);

      // Check INSERT was called
      const insertQuery = env.DB._queries.find(q => q.sql.includes('INSERT INTO outbound_campaigns'));
      expect(insertQuery).toBeDefined();
      expect(insertQuery!.params).toContain('My Campaign');
      expect(insertQuery!.params).toContain('my-campaign');
      expect(insertQuery!.params).toContain('["email","push","whatsapp"]');
      expect(insertQuery!.params).toContain('["email","push","whatsapp"]');
    });

    it('rejects fallback chain entries not present in channels', async () => {
      env.DB.onQuery(/SELECT.*outbound_campaigns/, () => []);

      const req = makeRequest('POST', '/api/admin/campaigns/outbound', {
        name: 'Bad Chain',
        slug: 'bad-chain',
        channels: ['email'],
        fallback_chain: ['email', 'push'],
      }, adminHeaders);
      const res = await handleCreateOutboundCampaign(req, env as any);

      expect(res.status).toBe(400);
    });

    it('caps daily_limit at 200', async () => {
      env.DB.onQuery(/SELECT.*outbound_campaigns/, () => []);

      const req = makeRequest('POST', '/api/admin/campaigns/outbound', {
        name: 'High Volume',
        slug: 'high-volume',
        daily_limit: 500,
      }, adminHeaders);
      const res = await handleCreateOutboundCampaign(req, env as any);

      const insertQuery = env.DB._queries.find(q => q.sql.includes('INSERT INTO outbound_campaigns'));
      expect(insertQuery).toBeDefined();
      // daily_limit should be capped at 200, it's the 5th param
      expect(insertQuery!.params[4]).toBe(200);
    });
  });

  // ─── Start campaign ───────────────────────────────────────────────

  describe('handleStartOutboundCampaign()', () => {
    it('returns 404 for non-existent campaign', async () => {
      env.DB.onQuery(/SELECT.*outbound_campaigns.*WHERE id/, () => []);

      const req = makeRequest('POST', '/api/admin/campaigns/outbound/999/start', null, adminHeaders);
      const res = await handleStartOutboundCampaign(req, env as any, 999);
      expect(res.status).toBe(404);
    });

    it('rejects starting an already active campaign', async () => {
      env.DB.onQuery(/SELECT.*outbound_campaigns.*WHERE id/, () => [{
        id: 1, status: 'active', slug: 'test',
      }]);

      const req = makeRequest('POST', '/api/admin/campaigns/outbound/1/start', null, adminHeaders);
      const res = await handleStartOutboundCampaign(req, env as any, 1);
      expect(res.status).toBe(400);
    });

    it('rejects restarting a completed campaign', async () => {
      env.DB.onQuery(/SELECT.*outbound_campaigns.*WHERE id/, () => [{
        id: 1, status: 'completed', slug: 'test',
      }]);

      const req = makeRequest('POST', '/api/admin/campaigns/outbound/1/start', null, adminHeaders);
      const res = await handleStartOutboundCampaign(req, env as any, 1);
      expect(res.status).toBe(400);
    });

    it('activates a draft campaign', async () => {
      env.DB.onQuery(/SELECT.*outbound_campaigns.*WHERE id/, () => [{
        id: 1, status: 'draft', slug: 'test', started_at: null, warmup_day: 0,
      }]);

      const req = makeRequest('POST', '/api/admin/campaigns/outbound/1/start', null, adminHeaders);
      const res = await handleStartOutboundCampaign(req, env as any, 1);
      const body = await res.json() as any;

      expect(res.status).toBe(200);
      expect(body.data.status).toBe('active');
      expect(body.data.message).toContain('warmup begins');

      // Check UPDATE was executed
      const updateQuery = env.DB._queries.find(q =>
        q.sql.includes('UPDATE outbound_campaigns') && q.sql.includes('active')
      );
      expect(updateQuery).toBeDefined();
    });

    it('resumes a paused campaign', async () => {
      env.DB.onQuery(/SELECT.*outbound_campaigns.*WHERE id/, () => [{
        id: 1, status: 'paused', slug: 'test', started_at: 1700000000, warmup_day: 5,
      }]);

      const req = makeRequest('POST', '/api/admin/campaigns/outbound/1/start', null, adminHeaders);
      const res = await handleStartOutboundCampaign(req, env as any, 1);
      const body = await res.json() as any;

      expect(res.status).toBe(200);
      expect(body.data.status).toBe('active');
      expect(body.data.message).toContain('resumed');
    });
  });

  // ─── Pause campaign ───────────────────────────────────────────────

  describe('handlePauseOutboundCampaign()', () => {
    it('returns 404 for non-existent campaign', async () => {
      env.DB.onQuery(/SELECT.*outbound_campaigns.*WHERE id/, () => []);

      const req = makeRequest('POST', '/api/admin/campaigns/outbound/1/pause', null, adminHeaders);
      const res = await handlePauseOutboundCampaign(req, env as any, 1);
      expect(res.status).toBe(404);
    });

    it('rejects pausing a non-active campaign', async () => {
      env.DB.onQuery(/SELECT.*outbound_campaigns.*WHERE id/, () => [{
        id: 1, status: 'draft', slug: 'test',
      }]);

      const req = makeRequest('POST', '/api/admin/campaigns/outbound/1/pause', null, adminHeaders);
      const res = await handlePauseOutboundCampaign(req, env as any, 1);
      expect(res.status).toBe(400);
    });

    it('pauses an active campaign', async () => {
      env.DB.onQuery(/SELECT.*outbound_campaigns.*WHERE id/, () => [{
        id: 1, status: 'active', slug: 'test', total_sent: 42,
      }]);

      const req = makeRequest('POST', '/api/admin/campaigns/outbound/1/pause', null, adminHeaders);
      const res = await handlePauseOutboundCampaign(req, env as any, 1);
      const body = await res.json() as any;

      expect(res.status).toBe(200);
      expect(body.data.status).toBe('paused');
      expect(body.data.message).toContain('42 emails sent');

      // Check UPDATE was executed
      const updateQuery = env.DB._queries.find(q =>
        q.sql.includes('UPDATE outbound_campaigns') && q.sql.includes('paused')
      );
      expect(updateQuery).toBeDefined();
    });
  });
});
