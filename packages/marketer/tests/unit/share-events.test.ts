/**
 * Share Event Handler Tests
 *
 * Comprehensive tests for all 6 share PLG event handlers:
 *   handleShareCreated, handleShareViewed, handleShareEngaged,
 *   handleShareCTAClicked, handleShareConverted, handleShareRevoked
 *
 * Validates: D1 operations, KV caching, PQL scoring, lead status
 * transitions, email enrollment, team notifications, audit trail.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleShareCreated,
  handleShareViewed,
  handleShareEngaged,
  handleShareCTAClicked,
  handleShareConverted,
  handleShareRevoked,
} from '../../src/events/share-events';
import { createMockEnv, type MockEnv } from '../helpers';
import {
  KV_PREFIX,
  SHARE_LEAD_STATUS,
  PLG_STAGE,
  PQL_THRESHOLD,
} from '../../src/constants';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const timestamp = '2025-01-15T12:00:00.000Z';

function makeShareCreatedData(overrides = {}) {
  return {
    category: 'share' as const,
    plgStage: PLG_STAGE.AWARENESS,
    pqlScoreHint: 5,
    owner: 'owner@test.com',
    token: 'vs_test123',
    scopes: ['pulse', 'action'],
    role: 'viewer',
    tier: 'pro',
    ...overrides,
  };
}

function makeShareViewedData(overrides = {}) {
  return {
    category: 'share' as const,
    plgStage: PLG_STAGE.ACTIVATION,
    pqlScoreHint: 10,
    token: 'vs_test123',
    owner: 'owner@test.com',
    accessCount: 1,
    scopes: ['pulse'],
    ip: '1.2.3.4',
    ...overrides,
  };
}

function makeShareEngagedData(overrides = {}) {
  return {
    category: 'share' as const,
    plgStage: PLG_STAGE.ENGAGEMENT,
    pqlScoreHint: 15,
    token: 'vs_test123',
    dwellSeconds: 60,
    ...overrides,
  };
}

function makeShareCTAClickedData(overrides = {}) {
  return {
    category: 'share' as const,
    plgStage: PLG_STAGE.INTENT,
    pqlScoreHint: 30,
    token: 'vs_test123',
    dwellSeconds: 90,
    ...overrides,
  };
}

function makeShareConvertedData(overrides = {}) {
  return {
    category: 'share' as const,
    plgStage: PLG_STAGE.CONVERSION,
    pqlScoreHint: 100,
    shareToken: 'vs_test123',
    newUserId: 'newuser@test.com',
    ...overrides,
  };
}

function makeShareRevokedData(overrides = {}) {
  return {
    category: 'share' as const,
    plgStage: PLG_STAGE.LIFECYCLE,
    pqlScoreHint: 0,
    owner: 'owner@test.com',
    token: 'vs_test123',
    ...overrides,
  };
}

/**
 * Register D1 handlers with an optional share lead row and owner stats row.
 * MockD1Database._findHandler returns the FIRST regex match, so we must
 * register handlers in the correct order — specific handlers first.
 */
function setupHandlers(env: MockEnv, shareLeadRow?: Record<string, unknown>, ownerStatsRow?: Record<string, unknown>) {
  env.DB.clearHandlers();
  env.DB.onQuery(/SELECT.*share_leads/, () => shareLeadRow ? [shareLeadRow] : []);
  env.DB.onQuery(/SELECT.*share_owner_stats/, () => ownerStatsRow ? [ownerStatsRow] : []);
  env.DB.onQuery(/SELECT.*marketing_contacts/, () => []);
  env.DB.onQuery(/SELECT.*email_sequences.*trigger_event/, () => []);
  env.DB.onQuery(/SELECT.*email_sends/, () => []);
}

// ─── handleShareCreated ──────────────────────────────────────────────────────

describe('handleShareCreated()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
    setupHandlers(env);
  });

  describe('owner stats upsert', () => {
    it('inserts new owner_stats row when owner has no prior shares', async () => {
      await handleShareCreated(env as any, makeShareCreatedData(), timestamp);

      const insertQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('INSERT INTO share_owner_stats')
      );
      expect(insertQuery).toBeDefined();
      expect(insertQuery!.params).toContain('owner@test.com');
    });

    it('updates existing owner_stats row when owner already has shares', async () => {
      setupHandlers(env, undefined, { id: 1, owner_email: 'owner@test.com', total_shares: 3 });

      await handleShareCreated(env as any, makeShareCreatedData(), timestamp);

      const updateQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('UPDATE share_owner_stats')
      );
      expect(updateQuery).toBeDefined();
    });
  });

  describe('KV cache', () => {
    it('creates KV cache entry for new owner', async () => {
      await handleShareCreated(env as any, makeShareCreatedData(), timestamp);

      const kvKey = `${KV_PREFIX.SHARE_OWNER_STATS}owner@test.com`;
      const raw = await env.KV_MARKETING.get(kvKey);
      expect(raw).not.toBeNull();
      const cached = JSON.parse(raw!);
      expect(cached.totalShares).toBe(1);
    });

    it('increments existing KV cache', async () => {
      const kvKey = `${KV_PREFIX.SHARE_OWNER_STATS}owner@test.com`;
      await env.KV_MARKETING.put(
        kvKey,
        JSON.stringify({ totalShares: 2, totalViews: 5, totalConversions: 1 })
      );

      await handleShareCreated(env as any, makeShareCreatedData(), timestamp);

      const cached = JSON.parse(await env.KV_MARKETING.get(kvKey) ?? '{}');
      expect(cached.totalShares).toBe(3);
      expect(cached.lastShareAt).toBe(timestamp);
    });
  });

  describe('audit trail', () => {
    it('inserts affiliate_notes audit row', async () => {
      await handleShareCreated(env as any, makeShareCreatedData(), timestamp);

      const noteInsert = env.DB._queries.find(
        (q: any) => q.sql.includes('INSERT INTO affiliate_notes')
      );
      expect(noteInsert).toBeDefined();
      // Affiliate code should be share: prefixed
      expect(noteInsert!.params[0]).toMatch(/^share:/);
    });
  });
});

// ─── handleShareViewed ───────────────────────────────────────────────────────

describe('handleShareViewed()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
    setupHandlers(env);
  });

  describe('lead upsert', () => {
    it('creates new share_leads row on first view', async () => {
      await handleShareViewed(env as any, makeShareViewedData(), timestamp);

      const insertQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('INSERT INTO share_leads')
      );
      expect(insertQuery).toBeDefined();
      expect(insertQuery!.params).toContain('vs_test123');
    });

    it('updates existing lead on repeat view', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 10,
        status: SHARE_LEAD_STATUS.COLD,
        total_views: 1,
        total_dwell_seconds: 0,
        owner_email: null,
      });

      await handleShareViewed(
        env as any,
        makeShareViewedData({ accessCount: 2, pqlScoreHint: 10 }),
        timestamp
      );

      const updateQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('UPDATE share_leads')
      );
      expect(updateQuery).toBeDefined();
    });
  });

  describe('PQL scoring', () => {
    it('sets initial lead status based on pqlScoreHint', async () => {
      await handleShareViewed(
        env as any,
        makeShareViewedData({ pqlScoreHint: 5 }),
        timestamp
      );

      const insertQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('INSERT INTO share_leads')
      );
      expect(insertQuery).toBeDefined();
      // pqlScoreHint=5 → cold status
      expect(insertQuery!.params).toContain(SHARE_LEAD_STATUS.COLD);
    });

    it('promotes to warm when cumulative score crosses 20', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 15,
        status: SHARE_LEAD_STATUS.COLD,
        total_views: 2,
        total_dwell_seconds: 0,
        owner_email: null,
      });

      await handleShareViewed(
        env as any,
        makeShareViewedData({ pqlScoreHint: 10 }),
        timestamp
      );

      const updateQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('UPDATE share_leads')
      );
      expect(updateQuery).toBeDefined();
      // 15 + 10 = 25 → warm
      expect(updateQuery!.params).toContain(SHARE_LEAD_STATUS.WARM);
    });
  });

  describe('daily view counter', () => {
    it('increments KV daily view counter', async () => {
      await handleShareViewed(env as any, makeShareViewedData(), timestamp);

      const today = new Date().toISOString().slice(0, 10);
      const count = await env.KV_MARKETING.get(`${KV_PREFIX.DAILY_SHARE_VIEWS}${today}`);
      expect(count).toBe('1');
    });

    it('accumulates multiple views in same day', async () => {
      const today = new Date().toISOString().slice(0, 10);
      await env.KV_MARKETING.put(`${KV_PREFIX.DAILY_SHARE_VIEWS}${today}`, '7');

      await handleShareViewed(env as any, makeShareViewedData(), timestamp);

      const count = await env.KV_MARKETING.get(`${KV_PREFIX.DAILY_SHARE_VIEWS}${today}`);
      expect(count).toBe('8');
    });
  });

  describe('owner_email population', () => {
    it('sets owner_email on new share_leads INSERT', async () => {
      await handleShareViewed(env as any, makeShareViewedData(), timestamp);

      const insertQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('INSERT INTO share_leads')
      );
      expect(insertQuery).toBeDefined();
      expect(insertQuery!.params).toContain('owner@test.com');
    });

    it('sets owner_email on existing lead UPDATE', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 10,
        status: SHARE_LEAD_STATUS.COLD,
        total_views: 1,
        total_dwell_seconds: 0,
        owner_email: null,
      });

      await handleShareViewed(
        env as any,
        makeShareViewedData({ accessCount: 2 }),
        timestamp
      );

      const updateQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('UPDATE share_leads')
      );
      expect(updateQuery).toBeDefined();
      expect(updateQuery!.params).toContain('owner@test.com');
    });

    it('handles missing owner gracefully (null)', async () => {
      await handleShareViewed(
        env as any,
        makeShareViewedData({ owner: undefined }),
        timestamp
      );

      const insertQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('INSERT INTO share_leads')
      );
      expect(insertQuery).toBeDefined();
      // owner_email should be null when owner is absent
      expect(insertQuery!.params).toContain(null);
    });
  });

  describe('share_owner_stats.total_views', () => {
    it('increments total_views in D1 for existing owner', async () => {
      setupHandlers(env, undefined, { id: 1, owner_email: 'owner@test.com', total_views: 5 });

      await handleShareViewed(env as any, makeShareViewedData(), timestamp);

      const ownerUpdate = env.DB._queries.find(
        (q: any) =>
          q.sql.includes('UPDATE share_owner_stats') &&
          q.sql.includes('total_views')
      );
      expect(ownerUpdate).toBeDefined();
    });

    it('inserts new owner_stats row when owner has no prior stats', async () => {
      await handleShareViewed(env as any, makeShareViewedData(), timestamp);

      const ownerInsert = env.DB._queries.find(
        (q: any) =>
          q.sql.includes('INSERT INTO share_owner_stats') &&
          q.sql.includes('total_views')
      );
      expect(ownerInsert).toBeDefined();
      expect(ownerInsert!.params).toContain('owner@test.com');
    });

    it('does NOT update owner stats when no owner in payload', async () => {
      await handleShareViewed(
        env as any,
        makeShareViewedData({ owner: undefined }),
        timestamp
      );

      const ownerQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('share_owner_stats')
      );
      expect(ownerQuery).toBeUndefined();
    });

    it('increments KV totalViews cache', async () => {
      const kvKey = `${KV_PREFIX.SHARE_OWNER_STATS}owner@test.com`;
      await env.KV_MARKETING.put(
        kvKey,
        JSON.stringify({ totalShares: 2, totalViews: 5, totalConversions: 1 })
      );

      await handleShareViewed(env as any, makeShareViewedData(), timestamp);

      const cached = JSON.parse(await env.KV_MARKETING.get(kvKey) ?? '{}');
      expect(cached.totalViews).toBe(6);
    });
  });

  describe('metadata population', () => {
    it('populates metadata JSON on new lead', async () => {
      await handleShareViewed(
        env as any,
        makeShareViewedData({ ip: '10.0.0.1' }),
        timestamp
      );

      const insertQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('INSERT INTO share_leads')
      );
      expect(insertQuery).toBeDefined();
      const metadataParam = insertQuery!.params.find(
        (p: any) => typeof p === 'string' && p.includes('"ip"')
      );
      expect(metadataParam).toBeDefined();
      const parsed = JSON.parse(metadataParam! as string);
      expect(parsed.ip).toBe('10.0.0.1');
      expect(parsed.scopes).toEqual(['pulse']);
    });

    it('updates metadata on repeat view', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 10,
        status: SHARE_LEAD_STATUS.COLD,
        total_views: 1,
        total_dwell_seconds: 0,
        owner_email: null,
      });

      await handleShareViewed(
        env as any,
        makeShareViewedData({ accessCount: 2, ip: '10.0.0.2' }),
        timestamp
      );

      const updateQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('UPDATE share_leads')
      );
      expect(updateQuery).toBeDefined();
      const metadataParam = updateQuery!.params.find(
        (p: any) => typeof p === 'string' && p.includes('"ip"')
      );
      expect(metadataParam).toBeDefined();
    });
  });
});

// ─── handleShareEngaged ──────────────────────────────────────────────────────

describe('handleShareEngaged()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
    setupHandlers(env);
  });

  describe('PQL scoring', () => {
    it('increments PQL score with dwell hint', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 10,
        status: SHARE_LEAD_STATUS.COLD,
        total_dwell_seconds: 20,
        owner_email: 'owner@test.com',
      });

      await handleShareEngaged(
        env as any,
        makeShareEngagedData({ dwellSeconds: 60, pqlScoreHint: 15 }),
        timestamp
      );

      const updateQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('UPDATE share_leads')
      );
      expect(updateQuery).toBeDefined();
      // score: 10 + 15 = 25
      expect(updateQuery!.params).toContain(25);
    });

    it('transitions to "engagement" PLG stage', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 10,
        status: SHARE_LEAD_STATUS.COLD,
        total_dwell_seconds: 0,
        owner_email: null,
      });

      await handleShareEngaged(env as any, makeShareEngagedData(), timestamp);

      const updateQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('UPDATE share_leads')
      );
      expect(updateQuery).toBeDefined();
      expect(updateQuery!.params).toContain(PLG_STAGE.ENGAGEMENT);
    });
  });

  describe('high engagement (120s+)', () => {
    it('increments owner engagement counter for 120s+ dwell', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 10,
        status: SHARE_LEAD_STATUS.COLD,
        total_dwell_seconds: 30,
        owner_email: 'owner@test.com',
      });

      await handleShareEngaged(
        env as any,
        makeShareEngagedData({ dwellSeconds: 120, pqlScoreHint: 15 }),
        timestamp
      );

      const ownerUpdate = env.DB._queries.find(
        (q: any) =>
          q.sql.includes('UPDATE share_owner_stats') &&
          q.sql.includes('total_engagements')
      );
      expect(ownerUpdate).toBeDefined();
    });

    it('enrolls owner in email sequence for 120s+ dwell without crashing', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 10,
        status: SHARE_LEAD_STATUS.COLD,
        total_dwell_seconds: 30,
        owner_email: 'owner@test.com',
      });

      await expect(
        handleShareEngaged(
          env as any,
          makeShareEngagedData({ dwellSeconds: 120, pqlScoreHint: 15 }),
          timestamp
        )
      ).resolves.not.toThrow();
    });

    it('does NOT trigger high-engagement actions for <120s dwell', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 10,
        status: SHARE_LEAD_STATUS.COLD,
        total_dwell_seconds: 20,
        owner_email: 'owner@test.com',
      });

      await handleShareEngaged(
        env as any,
        makeShareEngagedData({ dwellSeconds: 60, pqlScoreHint: 10 }),
        timestamp
      );

      const ownerUpdate = env.DB._queries.find(
        (q: any) =>
          q.sql.includes('UPDATE share_owner_stats') &&
          q.sql.includes('total_engagements')
      );
      expect(ownerUpdate).toBeUndefined();
    });
  });

  describe('PQL threshold crossing', () => {
    it('does not crash when PQL threshold is crossed (score < 80 → 80+)', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 70,
        status: SHARE_LEAD_STATUS.HOT,
        total_dwell_seconds: 200,
        owner_email: 'owner@test.com',
      });

      await expect(
        handleShareEngaged(
          env as any,
          makeShareEngagedData({ dwellSeconds: 120, pqlScoreHint: 15 }),
          timestamp
        )
      ).resolves.not.toThrow();
    });
  });

  describe('lead creation fallback', () => {
    it('creates new lead if none exists yet', async () => {
      await handleShareEngaged(env as any, makeShareEngagedData(), timestamp);

      const insertQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('INSERT INTO share_leads')
      );
      expect(insertQuery).toBeDefined();
      expect(insertQuery!.params).toContain('vs_test123');
    });
  });
});

// ─── handleShareCTAClicked ──────────────────────────────────────────────────

describe('handleShareCTAClicked()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
    setupHandlers(env);
  });

  describe('lead update', () => {
    it('updates existing lead to intent stage', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 40,
        status: SHARE_LEAD_STATUS.WARM,
        owner_email: 'owner@test.com',
      });

      await handleShareCTAClicked(env as any, makeShareCTAClickedData(), timestamp);

      const updateQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('UPDATE share_leads')
      );
      expect(updateQuery).toBeDefined();
      expect(updateQuery!.params).toContain(PLG_STAGE.INTENT);
    });

    it('creates new lead if none exists', async () => {
      await handleShareCTAClicked(env as any, makeShareCTAClickedData(), timestamp);

      const insertQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('INSERT INTO share_leads')
      );
      expect(insertQuery).toBeDefined();
      expect(insertQuery!.params).toContain(PLG_STAGE.INTENT);
    });
  });

  describe('owner CTA click counter', () => {
    it('increments owner total_cta_clicks when lead has owner_email', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 40,
        status: SHARE_LEAD_STATUS.WARM,
        owner_email: 'owner@test.com',
      });

      await handleShareCTAClicked(env as any, makeShareCTAClickedData(), timestamp);

      const ownerUpdate = env.DB._queries.find(
        (q: any) =>
          q.sql.includes('UPDATE share_owner_stats') &&
          q.sql.includes('total_cta_clicks')
      );
      expect(ownerUpdate).toBeDefined();
    });

    it('does NOT update owner stats when lead has no owner_email', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 40,
        status: SHARE_LEAD_STATUS.WARM,
        owner_email: null,
      });

      await handleShareCTAClicked(env as any, makeShareCTAClickedData(), timestamp);

      const ownerUpdate = env.DB._queries.find(
        (q: any) =>
          q.sql.includes('UPDATE share_owner_stats') &&
          q.sql.includes('total_cta_clicks')
      );
      expect(ownerUpdate).toBeUndefined();
    });
  });

  describe('PQL threshold crossing', () => {
    it('does not crash on PQL threshold crossing', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 60,
        status: SHARE_LEAD_STATUS.HOT,
        owner_email: 'owner@test.com',
      });

      await expect(
        handleShareCTAClicked(env as any, makeShareCTAClickedData({ pqlScoreHint: 30 }), timestamp)
      ).resolves.not.toThrow();
    });
  });
});

// ─── handleShareConverted ───────────────────────────────────────────────────

describe('handleShareConverted()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
    setupHandlers(env);
  });

  describe('lead conversion', () => {
    it('marks existing lead as converted', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 75,
        status: SHARE_LEAD_STATUS.HOT,
        owner_email: 'owner@test.com',
      });

      await handleShareConverted(env as any, makeShareConvertedData(), timestamp);

      const updateQuery = env.DB._queries.find(
        (q: any) =>
          q.sql.includes('UPDATE share_leads') &&
          q.sql.includes('status')
      );
      expect(updateQuery).toBeDefined();
      expect(updateQuery!.params).toContain(SHARE_LEAD_STATUS.CONVERTED);
      expect(updateQuery!.params).toContain(PLG_STAGE.CONVERSION);
    });

    it('sets converted_user_id to the new user', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 80,
        status: SHARE_LEAD_STATUS.PQL,
        owner_email: 'owner@test.com',
      });

      await handleShareConverted(env as any, makeShareConvertedData(), timestamp);

      const updateQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('UPDATE share_leads')
      );
      expect(updateQuery).toBeDefined();
      expect(updateQuery!.params).toContain('newuser@test.com');
    });
  });

  describe('CRM contact upsert', () => {
    it('upserts new CRM contact with share source', async () => {
      await handleShareConverted(env as any, makeShareConvertedData(), timestamp);

      const crmQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('marketing_contacts')
      );
      expect(crmQuery).toBeDefined();
    });
  });

  describe('owner credit', () => {
    it('increments owner total_conversions in D1', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 80,
        status: SHARE_LEAD_STATUS.PQL,
        owner_email: 'owner@test.com',
      });

      await handleShareConverted(env as any, makeShareConvertedData(), timestamp);

      const ownerUpdate = env.DB._queries.find(
        (q: any) =>
          q.sql.includes('UPDATE share_owner_stats') &&
          q.sql.includes('total_conversions')
      );
      expect(ownerUpdate).toBeDefined();
    });

    it('updates KV cache with conversion count', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 80,
        status: SHARE_LEAD_STATUS.PQL,
        owner_email: 'owner@test.com',
      });

      const kvKey = `${KV_PREFIX.SHARE_OWNER_STATS}owner@test.com`;
      await env.KV_MARKETING.put(
        kvKey,
        JSON.stringify({ totalShares: 5, totalViews: 20, totalConversions: 2 })
      );

      await handleShareConverted(env as any, makeShareConvertedData(), timestamp);

      const cached = JSON.parse(await env.KV_MARKETING.get(kvKey) ?? '{}');
      expect(cached.totalConversions).toBe(3);
    });
  });

  describe('email enrollment', () => {
    it('enrolls owner in conversion celebration sequence without crashing', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 80,
        status: SHARE_LEAD_STATUS.PQL,
        owner_email: 'owner@test.com',
      });

      await expect(
        handleShareConverted(env as any, makeShareConvertedData(), timestamp)
      ).resolves.not.toThrow();
    });
  });

  describe('audit trail', () => {
    it('inserts affiliate_notes audit row for owner', async () => {
      setupHandlers(env, {
        id: 1,
        token: 'vs_test123',
        pql_score: 80,
        status: SHARE_LEAD_STATUS.PQL,
        owner_email: 'owner@test.com',
      });

      await handleShareConverted(env as any, makeShareConvertedData(), timestamp);

      const noteInsert = env.DB._queries.find(
        (q: any) => q.sql.includes('INSERT INTO affiliate_notes')
      );
      expect(noteInsert).toBeDefined();
    });
  });

  describe('graceful handling', () => {
    it('handles conversion when no prior lead exists', async () => {
      await expect(
        handleShareConverted(env as any, makeShareConvertedData(), timestamp)
      ).resolves.not.toThrow();
    });
  });
});

// ─── handleShareRevoked ─────────────────────────────────────────────────────

describe('handleShareRevoked()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
    setupHandlers(env);
  });

  describe('lead revocation', () => {
    it('marks all unconverted leads for token as revoked', async () => {
      await handleShareRevoked(env as any, makeShareRevokedData(), timestamp);

      const updateQuery = env.DB._queries.find(
        (q: any) =>
          q.sql.includes('UPDATE share_leads') &&
          q.sql.includes('status')
      );
      expect(updateQuery).toBeDefined();
      expect(updateQuery!.params).toContain(SHARE_LEAD_STATUS.REVOKED);
    });

    it('preserves already-converted leads (excluded in WHERE clause params)', async () => {
      await handleShareRevoked(env as any, makeShareRevokedData(), timestamp);

      const updateQuery = env.DB._queries.find(
        (q: any) => q.sql.includes('UPDATE share_leads')
      );
      expect(updateQuery).toBeDefined();
      // The WHERE clause excludes converted leads via a != ? param
      expect(updateQuery!.params).toContain(SHARE_LEAD_STATUS.CONVERTED);
    });
  });

  describe('audit trail', () => {
    it('inserts affiliate_notes row for revocation', async () => {
      await handleShareRevoked(env as any, makeShareRevokedData(), timestamp);

      const noteInsert = env.DB._queries.find(
        (q: any) => q.sql.includes('INSERT INTO affiliate_notes')
      );
      expect(noteInsert).toBeDefined();
      expect(noteInsert!.params[0]).toMatch(/^share:/);
    });
  });
});

// ─── PQL Score → Lead Status Integration ────────────────────────────────────

describe('PQL scoring integration', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
    setupHandlers(env);
  });

  it('scores correctly through full lifecycle: cold → warm → hot → PQL', async () => {
    // Step 1: First view (pql=10 → cold)
    await handleShareViewed(
      env as any,
      makeShareViewedData({ pqlScoreHint: 10 }),
      timestamp
    );
    const insertQuery = env.DB._queries.find(
      (q: any) => q.sql.includes('INSERT INTO share_leads')
    );
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.params).toContain(SHARE_LEAD_STATUS.COLD);

    // Step 2: Engagement takes to warm (10 + 15 = 25 ≥ WARM threshold)
    env.DB.clearQueries();
    setupHandlers(env, {
      id: 1,
      token: 'vs_test123',
      pql_score: 10,
      status: SHARE_LEAD_STATUS.COLD,
      total_dwell_seconds: 0,
      owner_email: 'owner@test.com',
    });

    await handleShareEngaged(
      env as any,
      makeShareEngagedData({ pqlScoreHint: 15 }),
      timestamp
    );
    let updateQuery = env.DB._queries.find(
      (q: any) => q.sql.includes('UPDATE share_leads')
    );
    expect(updateQuery).toBeDefined();
    expect(updateQuery!.params).toContain(SHARE_LEAD_STATUS.WARM);

    // Step 3: CTA click takes to hot (25 + 30 = 55 ≥ HOT threshold)
    env.DB.clearQueries();
    setupHandlers(env, {
      id: 1,
      token: 'vs_test123',
      pql_score: 25,
      status: SHARE_LEAD_STATUS.WARM,
      total_dwell_seconds: 60,
      owner_email: 'owner@test.com',
    });

    await handleShareCTAClicked(
      env as any,
      makeShareCTAClickedData({ pqlScoreHint: 30 }),
      timestamp
    );
    updateQuery = env.DB._queries.find(
      (q: any) => q.sql.includes('UPDATE share_leads')
    );
    expect(updateQuery).toBeDefined();
    expect(updateQuery!.params).toContain(SHARE_LEAD_STATUS.HOT);

    // Step 4: Another CTA click takes to PQL (55 + 30 = 85 ≥ PQL threshold)
    env.DB.clearQueries();
    setupHandlers(env, {
      id: 1,
      token: 'vs_test123',
      pql_score: 55,
      status: SHARE_LEAD_STATUS.HOT,
      owner_email: 'owner@test.com',
    });

    await handleShareCTAClicked(
      env as any,
      makeShareCTAClickedData({ pqlScoreHint: 30 }),
      timestamp
    );
    updateQuery = env.DB._queries.find(
      (q: any) => q.sql.includes('UPDATE share_leads')
    );
    expect(updateQuery).toBeDefined();
    expect(updateQuery!.params).toContain(SHARE_LEAD_STATUS.PQL);
  });
});
