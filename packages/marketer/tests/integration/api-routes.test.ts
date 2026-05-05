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

  describe('campaign objectives API', () => {
    it('requires admin auth for the screen route', async () => {
      const req = makeRequest('GET', '/api/admin/campaign-objectives/screen');
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(401);
    });

    it('returns the admin screen with valid auth', async () => {
      const req = makeRequest('GET', '/api/admin/campaign-objectives/screen', undefined, {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
      });
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
    });

    it('supports happy-path create then read', async () => {
      let inserted: any = null;
      env.DB.onQuery(/INSERT INTO campaign_objectives/, (params) => {
        inserted = {
          id: String(params[0]),
          objective_type: params[1],
          campaign_name: params[2],
          business_goal_statement: params[3],
          urgency: params[4],
          success_metric_primary: params[5],
          success_metric_secondary: params[6],
          start_at: params[7],
          end_at: params[8],
          timezone: params[9],
          dry_run: params[10],
          created_by: params[11],
          created_at: params[12],
          updated_at: params[13],
          status: params[14],
        };
        return [];
      });
      env.DB.onQuery(/SELECT \* FROM campaign_objectives WHERE id = \?/, (params) => {
        if (inserted && params[0] === inserted.id) {
          return [inserted];
        }
        return [];
      });

      const createReq = makeRequest('POST', '/api/campaigns/objectives', {
        objectiveType: 'activation',
        campaignName: 'Integration Objective',
        businessGoalStatement: 'Prove objective create and read works through worker.fetch.',
        urgency: 'high',
        successMetricPrimary: 'Activated accounts',
        successMetricSecondary: 'Pipeline influenced',
        startAt: '2026-05-04T10:00:00.000Z',
        endAt: '2026-05-18T10:00:00.000Z',
        timezone: 'UTC',
        dryRun: false,
      }, {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        'x-admin-user': 'operator@visibility.test',
      });
      const createRes = await worker.fetch(createReq, env as any, ctx);
      expect(createRes.status).toBe(201);
      const createBody = await createRes.json() as any;
      const objectiveId = createBody.data.objective.id;

      const getReq = makeRequest('GET', `/api/campaigns/objectives/${objectiveId}`, undefined, {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
      });
      const getRes = await worker.fetch(getReq, env as any, ctx);
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json() as any;
      expect(getBody.data.objective.id).toBe(objectiveId);
      expect(getBody.data.objective.campaignName).toBe('Integration Objective');
    });
  });

  describe('campaign planning APIs', () => {
    it('returns the segment builder screen with valid auth', async () => {
      const req = makeRequest('GET', '/api/admin/campaign-segments/screen', undefined, {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
      });
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
    });

    it('supports preview then save then read for a segment', async () => {
      let previewCache: any = null;
      let savedSegment: any = null;
      env.DB.onQuery(/SELECT \* FROM segment_previews WHERE segment_hash = \?/, () => (previewCache ? [previewCache] : []));
      env.DB.onQuery(/INSERT INTO segment_previews/, (params) => {
        previewCache = {
          segment_hash: params[0],
          canonical_json: params[1],
          estimate: params[2],
          confidence_band: params[3],
          last_computed_at: params[4],
        };
        return [];
      });
      env.DB.onQuery(/SELECT \* FROM campaign_segments WHERE campaign_id = \? AND segment_hash = \?/, (params) => {
        return savedSegment && savedSegment.campaign_id === params[0] && savedSegment.segment_hash === params[1] ? [savedSegment] : [];
      });
      env.DB.onQuery(/INSERT INTO campaign_segments/, (params) => {
        savedSegment = {
          id: params[0],
          campaign_id: params[1],
          segment_hash: params[2],
          canonical_json: params[3],
          include_json: params[4],
          exclude_json: params[5],
          estimate: params[6],
          contradiction_json: params[7],
          created_at: params[8],
          updated_at: params[9],
        };
        return [];
      });
      env.DB.onQuery(/SELECT \* FROM campaign_segments WHERE id = \?/, (params) => (savedSegment && savedSegment.id === params[0] ? [savedSegment] : []));
      env.DB.onQuery(/SELECT \* FROM campaign_segments WHERE campaign_id = \? ORDER BY updated_at DESC/, () => (savedSegment ? [savedSegment] : []));

      const headers = { Authorization: `Bearer ${env.ADMIN_TOKEN}` };
      const payload = {
        campaignId: 'obj_demo_retention_local',
        includeConditions: [{ field: 'language', operator: 'equals', value: 'en' }],
        excludeConditions: [{ field: 'appInstalled', operator: 'equals', value: false }],
      };

      const previewRes = await worker.fetch(makeRequest('POST', '/api/segments/preview', payload, headers), env as any, ctx);
      expect(previewRes.status).toBe(200);
      const previewBody = await previewRes.json() as any;

      const saveRes = await worker.fetch(makeRequest('POST', '/api/segments/save', payload, headers), env as any, ctx);
      expect(saveRes.status).toBe(201);
      const saveBody = await saveRes.json() as any;
      const segmentId = saveBody.data.segment.id;

      const getRes = await worker.fetch(makeRequest('GET', `/api/segments/${segmentId}`, undefined, headers), env as any, ctx);
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json() as any;
      expect(getBody.data.segment.segmentHash).toBe(previewBody.data.segmentHash);

      const listRes = await worker.fetch(makeRequest('GET', '/api/segments?campaignId=obj_demo_retention_local', undefined, headers), env as any, ctx);
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json() as any;
      expect(listBody.data.segments).toHaveLength(1);
    });

    it('supports channel intent read-write and strategic brief dispatch', async () => {
      let campaignIntent: any = null;
      env.DB.onQuery(/INSERT INTO channel_intents/, (params) => {
        campaignIntent = {
          scope_type: params[0],
          scope_id: params[1],
          campaign_id: params[2],
          segment_id: params[3],
          hard_block_json: params[4],
          preferred_json: params[5],
          fallback_json: params[6],
          created_at: params[7],
          updated_at: params[8],
        };
        return [];
      });
      env.DB.onQuery(/SELECT \* FROM channel_intents WHERE scope_type = \? AND scope_id = \?/, () => (campaignIntent ? [campaignIntent] : []));
      env.DB.onQuery(/SELECT \* FROM channel_intents WHERE scope_type = 'campaign' AND scope_id = \?/, () => (campaignIntent ? [campaignIntent] : []));
      env.DB.onQuery(/SELECT \* FROM channel_intents WHERE scope_type = 'segment' AND campaign_id = \? ORDER BY updated_at DESC/, () => []);
      env.DB.onQuery(/SELECT id, objective_type, campaign_name, business_goal_statement, urgency, dry_run FROM campaign_objectives WHERE id = \?/, () => [{
        id: 'obj_demo_retention_local',
        objective_type: 'retention',
        campaign_name: 'Lifecycle Winback',
        business_goal_statement: 'Re-activate dormant high-intent users.',
        urgency: 'high',
        dry_run: 0,
      }]);
      env.DB.onQuery(/SELECT hard_block_json, preferred_json, fallback_json FROM channel_intents WHERE scope_type = 'campaign' AND scope_id = \?/, () => [{
        hard_block_json: '[]',
        preferred_json: '["whatsapp","sms"]',
        fallback_json: '["push"]',
      }]);
      env.DB.onQuery(/INSERT INTO strategic_brief_logs/, () => []);
      env = createMockEnv({
        ...env,
        SKRIP_SERVICE: {
          fetch: async () => new Response(JSON.stringify({
            requestId: 'skrip_req_123',
            channelSelected: 'whatsapp',
            deliveryMode: 'strategic',
            policyAdjustments: [],
            usedFallbackTemplate: false,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        } as any,
        SKRIP_SERVICE_TOKEN: 'skrip-token',
        SKRIP_SIGNING_SECRET: 'skrip-secret',
      });

      const headers = {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        'x-admin-user': 'operator@visibility.test',
      };
      const putRes = await worker.fetch(makeRequest('PUT', '/api/campaigns/obj_demo_retention_local/channel-intent', {
        preferredChannels: ['whatsapp', 'sms'],
        hardBlockChannels: ['push'],
        fallbackChannels: ['telegram'],
      }, headers), env as any, ctx);
      expect(putRes.status).toBe(201);

      const getRes = await worker.fetch(makeRequest('GET', '/api/campaigns/obj_demo_retention_local/channel-intent?availability=%7B%22sms%22%3Atrue%7D', undefined, headers), env as any, ctx);
      expect(getRes.status).toBe(200);

      const sendRes = await worker.fetch(makeRequest('POST', '/api/admin/strategic-briefings/send', {
        campaignId: 'obj_demo_retention_local',
        headline: 'Re-engage users before intent cools',
        bodyIntent: 'Follow up while trust is still present.',
        cta: 'Finish activation',
        tone: 'calm, direct, useful',
        forbiddenClaims: ['guaranteed results'],
        complianceTags: ['marketing'],
        locale: 'en',
        allowedHours: { startHour: 9, endHour: 18, timezone: 'UTC' },
        fallbackTemplateKey: 'agentic-skrip-followup',
        personalizationHints: ['plan'],
        channelPriority: ['whatsapp', 'email', 'sms'],
        strategyNonce: 'nonce_456',
      }, headers), env as any, ctx);
      expect(sendRes.status).toBe(200);
      const sendBody = await sendRes.json() as any;
      expect(sendBody.data.responseEnvelope.channelSelected).toBe('whatsapp');
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

  // ── New Admin Outbound Routes ─────────────────────────────────────────

  describe('GET /api/admin/outbound/ab-stats', () => {
    it('requires admin auth', async () => {
      const req = makeRequest('GET', '/api/admin/outbound/ab-stats');
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(401);
    });

    it('returns 200 with valid auth', async () => {
      const req = makeRequest('GET', '/api/admin/outbound/ab-stats', undefined, {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
      });
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/admin/outbound/linkedin-queue', () => {
    it('requires admin auth', async () => {
      const req = makeRequest('GET', '/api/admin/outbound/linkedin-queue');
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(401);
    });

    it('returns 200 with valid auth', async () => {
      env.DB.onQuery(/SELECT.*marketing_contacts/, () => []);
      const req = makeRequest('GET', '/api/admin/outbound/linkedin-queue', undefined, {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
      });
      const res = await worker.fetch(req, env as any, ctx);
      expect(res.status).toBe(200);
    });
  });

  // ── Webhook Route Wiring ──────────────────────────────────────────────

  describe('POST /webhooks/brevo/inbound (route wiring)', () => {
    it('routes to inbound handler (not 404)', async () => {
      const req = makeRequest('POST', '/webhooks/brevo/inbound', {
        From: { Address: 'test@test.com' },
        Subject: 'Re: Hello',
      });

      env.DB.onQuery(/UPDATE email_sends/, () => []);
      env.DB.onQuery(/UPDATE marketing_contacts/, () => []);
      env.DB.onQuery(/SELECT.*email_sends/, () => []);

      const res = await worker.fetch(req, env as any, ctx);
      // Should be 200 (processed) or 400 (validation) — NOT 404
      expect(res.status).not.toBe(404);
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
