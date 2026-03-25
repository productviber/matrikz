/**
 * Tests — Admin Outbound Endpoints: SLO, Cross-System Health, Reputation
 *
 * Covers the new observability endpoints added in the outbound improvements:
 * - handleOutboundSLO() — SLI/SLO compliance report
 * - handleCrossSystemHealth() — unified marketing+analytics health
 * - handleReputationTrend() — rolling reputation trend
 * - handleOutboundFunnel() — conversion funnel metrics
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleOutboundSLO,
  handleCrossSystemHealth,
  handleReputationTrend,
  handleOutboundFunnel,
} from '../../src/routes/admin';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';

// ═══════════════════════════════════════════════════════════════════════
// handleOutboundSLO()
// ═══════════════════════════════════════════════════════════════════════

describe('handleOutboundSLO()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
    // Default: zero sends (all SLIs at defaults)
    env.DB.onQuery(/SELECT.*email_sends.*total_attempted/, () => [{
      total_attempted: 0, total_delivered: 0, total_bounced: 0, total_failed: 0,
    }]);
    env.DB.onQuery(/SELECT.*AVG.*sent_at.*scheduled_at/, () => [{
      avg_latency: 0, max_latency: 0, p95_count: 0,
    }]);
    env.DB.onQuery(/SELECT.*marketing_contacts.*source\s*=\s*'outbound'/, () => [{
      total: 0, enriched: 0, avg_lag_hours: 0,
    }]);
  });

  it('returns 200 with SLO structure', async () => {
    const req = makeRequest('GET', '/api/admin/outbound/slo', undefined, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
    const res = await handleOutboundSLO(req, env as any);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    const data = body.data ?? body;
    expect(data.window).toBe('7d');
    expect(data.slos).toBeDefined();
    expect(data.slis).toBeDefined();
    expect(data.overall).toBeDefined();
  });

  it('reports HEALTHY when all SLIs meet targets (no sends)', async () => {
    const req = makeRequest('GET', '/api/admin/outbound/slo', undefined, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
    const res = await handleOutboundSLO(req, env as any);
    const body = await res.json() as any;
    const data = body.data ?? body;
    // With 0 sends, default delivery rate = 1.0, bounce rate = 0 → all met
    expect(data.overall).toBe('HEALTHY');
  });

  it('reports DEGRADED when bounce rate exceeds SLO', async () => {
    env.DB.clearHandlers();
    env.DB.onQuery(/total_attempted/, () => [{
      total_attempted: 100, total_delivered: 80, total_bounced: 15, total_failed: 20,
    }]);
    env.DB.onQuery(/AVG.*sent_at/, () => [{
      avg_latency: 60, max_latency: 300, p95_count: 0,
    }]);
    env.DB.onQuery(/marketing_contacts/, () => [{
      total: 50, enriched: 40, avg_lag_hours: 12,
    }]);

    const req = makeRequest('GET', '/api/admin/outbound/slo', undefined, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
    const res = await handleOutboundSLO(req, env as any);
    const body = await res.json() as any;
    const data = body.data ?? body;
    // 15% bounce rate > 5% target → DEGRADED
    expect(data.overall).toBe('DEGRADED');
    expect(data.slis.bounce_rate.met).toBe(false);
  });

  it('includes delivery rate SLI', async () => {
    env.DB.clearHandlers();
    env.DB.onQuery(/total_attempted/, () => [{
      total_attempted: 200, total_delivered: 195, total_bounced: 3, total_failed: 5,
    }]);
    env.DB.onQuery(/AVG.*sent_at/, () => [{
      avg_latency: 30, max_latency: 120, p95_count: 0,
    }]);
    env.DB.onQuery(/marketing_contacts/, () => [{
      total: 60, enriched: 55, avg_lag_hours: 10,
    }]);

    const req = makeRequest('GET', '/api/admin/outbound/slo', undefined, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
    const res = await handleOutboundSLO(req, env as any);
    const body = await res.json() as any;
    const data = body.data ?? body;

    expect(data.slis.delivery_rate.value).toBeCloseTo(0.975, 2);
    expect(data.slis.delivery_rate.met).toBe(true);
  });

  it('includes enrichment rate SLI', async () => {
    env.DB.clearHandlers();
    env.DB.onQuery(/total_attempted/, () => [{
      total_attempted: 100, total_delivered: 98, total_bounced: 1, total_failed: 2,
    }]);
    env.DB.onQuery(/AVG.*sent_at/, () => [{
      avg_latency: 45, max_latency: 200, p95_count: 0,
    }]);
    env.DB.onQuery(/marketing_contacts/, () => [{
      total: 100, enriched: 50, avg_lag_hours: 72,
    }]);

    const req = makeRequest('GET', '/api/admin/outbound/slo', undefined, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
    const res = await handleOutboundSLO(req, env as any);
    const body = await res.json() as any;
    const data = body.data ?? body;

    // 50% enrichment < 70% target → not met
    expect(data.slis.enrichment_rate.value).toBeCloseTo(0.5, 2);
    expect(data.slis.enrichment_rate.met).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// handleCrossSystemHealth()
// ═══════════════════════════════════════════════════════════════════════

describe('handleCrossSystemHealth()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
    // Default: return zeros for all marketing queries
    env.DB.onQuery(/SELECT.*marketing_contacts/, () => [{ total: 0, enrolled: 0 }]);
    env.DB.onQuery(/SELECT.*email_sends.*sent_at/, () => [{
      sent_24h: 0, failed_24h: 0, sent_7d: 0, failed_7d: 0,
    }]);
    env.DB.onQuery(/SELECT.*email_sends.*WHERE status/, () => [{ count: 0 }]);
    env.DB.onQuery(/SELECT.*suppression_list/, () => [{ count: 0 }]);
  });

  it('returns 200 with marketing health data', async () => {
    const req = makeRequest('GET', '/api/admin/outbound/system-health', undefined, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
    const res = await handleCrossSystemHealth(req, env as any);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    const data = body.data ?? body;
    expect(data.marketing).toBeDefined();
    expect(data.marketing.prospects).toBeDefined();
    expect(data.marketing.sends).toBeDefined();
    expect(data.marketing.compliance).toBeDefined();
  });

  it('includes suppression count in compliance', async () => {
    env.DB.clearHandlers();
    env.DB.onQuery(/SELECT.*marketing_contacts/, () => [{ total: 0, enrolled: 0 }]);
    env.DB.onQuery(/SELECT.*email_sends.*sent_at/, () => [{
      sent_24h: 0, failed_24h: 0, sent_7d: 0, failed_7d: 0,
    }]);
    env.DB.onQuery(/SELECT.*email_sends.*WHERE status/, () => [{ count: 0 }]);
    env.DB.onQuery(/SELECT.*suppression_list/, () => [{ count: 15 }]);

    const req = makeRequest('GET', '/api/admin/outbound/system-health', undefined, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
    const res = await handleCrossSystemHealth(req, env as any);
    const body = await res.json() as any;
    const data = body.data ?? body;
    expect(data.marketing.compliance.suppressions).toBe(15);
  });

  it('handles analytics service binding failure gracefully', async () => {
    // Mock analytics binding to reject
    env.ANALYTICS = {
      async fetch() { throw new Error('Service binding unreachable'); },
    } as any;

    const req = makeRequest('GET', '/api/admin/outbound/system-health', undefined, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
    const res = await handleCrossSystemHealth(req, env as any);
    // Should still return 200 with marketing data, analytics null
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const data = body.data ?? body;
    expect(data.marketing).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// handleReputationTrend()
// ═══════════════════════════════════════════════════════════════════════

describe('handleReputationTrend()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('returns 200 with empty trend when no data', async () => {
    const req = makeRequest('GET', '/api/admin/outbound/reputation', undefined, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
    const res = await handleReputationTrend(req, env as any);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    const data = body.data ?? body;
    expect(data.entries).toBe(0);
    expect(data.trend).toEqual([]);
    expect(data.avgHealthScore).toBe(100); // default when no data
    expect(data.status).toBe('GOOD');
  });

  it('returns reputation data from KV', async () => {
    await env.KV_MARKETING.put(
      'reputation:daily:2025-01-10',
      JSON.stringify({
        date: '2025-01-10', sent: 50, delivered: 48, bounced: 2, complained: 0,
        opened: 20, clicked: 5, replied: 1,
        bounceRate: 4, complaintRate: 0, openRate: 40, healthScore: 80,
      })
    );

    const req = makeRequest('GET', '/api/admin/outbound/reputation', undefined, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
    const res = await handleReputationTrend(req, env as any);
    const body = await res.json() as any;
    const data = body.data ?? body;

    expect(data.entries).toBe(1);
    expect(data.avgHealthScore).toBe(80);
    expect(data.status).toBe('GOOD');
    expect(data.trend[0].date).toBe('2025-01-10');
  });

  it('respects days query parameter', async () => {
    const req = makeRequest('GET', '/api/admin/outbound/reputation?days=7', undefined, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
    const res = await handleReputationTrend(req, env as any);
    const body = await res.json() as any;
    const data = body.data ?? body;
    expect(data.days).toBe(7);
  });

  it('caps days at 90', async () => {
    const req = makeRequest('GET', '/api/admin/outbound/reputation?days=999', undefined, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
    const res = await handleReputationTrend(req, env as any);
    const body = await res.json() as any;
    const data = body.data ?? body;
    expect(data.days).toBe(90);
  });

  it('returns WARNING status for moderate health', async () => {
    await env.KV_MARKETING.put(
      'reputation:daily:2025-01-10',
      JSON.stringify({
        date: '2025-01-10', sent: 100, delivered: 85, bounced: 15, complained: 0,
        opened: 20, clicked: 5, replied: 1,
        bounceRate: 15, complaintRate: 0, openRate: 20, healthScore: 65,
      })
    );

    const req = makeRequest('GET', '/api/admin/outbound/reputation', undefined, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
    const res = await handleReputationTrend(req, env as any);
    const body = await res.json() as any;
    const data = body.data ?? body;
    expect(data.status).toBe('WARNING');
  });

  it('returns CRITICAL status for low health', async () => {
    await env.KV_MARKETING.put(
      'reputation:daily:2025-01-10',
      JSON.stringify({
        date: '2025-01-10', sent: 100, delivered: 60, bounced: 40, complained: 5,
        opened: 5, clicked: 1, replied: 0,
        bounceRate: 40, complaintRate: 5, openRate: 5, healthScore: 10,
      })
    );

    const req = makeRequest('GET', '/api/admin/outbound/reputation', undefined, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
    const res = await handleReputationTrend(req, env as any);
    const body = await res.json() as any;
    const data = body.data ?? body;
    expect(data.status).toBe('CRITICAL');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// handleOutboundFunnel()
// ═══════════════════════════════════════════════════════════════════════

describe('handleOutboundFunnel()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
    // Default: return empty funnel stats
    env.DB.onQuery(/SELECT.*marketing_contacts/i, () => []);
    env.DB.onQuery(/SELECT.*email_sends/i, () => []);
  });

  it('returns 200 with funnel structure', async () => {
    const req = makeRequest('GET', '/api/admin/outbound/funnel', undefined, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    });
    const res = await handleOutboundFunnel(req, env as any);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    const data = body.data ?? body;
    expect(data).toBeDefined();
  });
});
