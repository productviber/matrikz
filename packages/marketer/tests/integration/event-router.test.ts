/**
 * Integration Tests — Event Router
 *
 * Tests the full POST /events flow: envelope validation, source
 * checking, and event dispatch to handlers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { routeEvent } from '../../src/events/router';
import { createMockEnv, createMockCtx, type MockEnv } from '../helpers';

describe('event router', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
  });

  function makeEventRequest(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request('https://test.workers.dev/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'cf-worker': 'visibility-analytics',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  it('rejects events from unknown sources', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'affiliate.conversion',
      source: 'unknown-service',
      timestamp: new Date().toISOString(),
      data: {},
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Unknown source');
  });

  it('rejects invalid envelopes (missing event)', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {},
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('Invalid event envelope');
  });

  it('rejects invalid envelopes (missing data)', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'affiliate.conversion',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(400);
  });

  it('accepts and routes affiliate.conversion events', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'affiliate.conversion',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {
        affiliateCode: 'test-aff',
        userId: 'user@test.com',
        eventType: 'purchase',
        amountCents: 2900,
        commissionCents: 580,
        plan: 'pro',
      },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.event).toBe('affiliate.conversion');
  });

  it('accepts and routes user.converted events', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'user.converted',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {
        userId: 'user@test.com',
        purchaseType: 'base',
        plan: 'monthly',
        amountCents: 2900,
        gateway: 'stripe',
      },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.event).toBe('user.converted');
  });

  it('accepts outbound.prospect_enriched payload with personalization and scoring metadata', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'outbound.prospect_enriched',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {
        prospectId: 42,
        domain: 'acme.io',
        contactEmail: 'growth@acme.io',
        companyName: 'Acme',
        score: 78,
        auditScore: 61,
        auditGrade: 'C',
        issueCount: 8,
        passCount: 10,
        techStack: ['wordpress', 'ga4'],
        primaryTopic: 'technical seo',
        industry: 'SaaS',
        angles: [{ type: 'missing_schema', hook: 'No structured data found', detail: 'Add JSON-LD' }],
        personalizationHooks: [
          'Your team can likely recover lost visibility with metadata fixes first.',
          'A fast issue triage could improve search snippet quality.',
        ],
        personalizationSource: 'ai-engine',
        authorityContext: {
          decisionId: 'dec-enriched-42',
          source: 'visibility-analytics',
          allowed: true,
          actorTenantId: 'default',
          targetTenantId: 'default',
        },
      },
    });

    const res = await routeEvent(req, env as any, ctx);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.event).toBe('outbound.prospect_enriched');
  });

  it('accepts unknown events for forward compatibility', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'some.future.event',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: { foo: 'bar' },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
  });

  it('rejects duplicate events within replay window', async () => {
    const ctx = createMockCtx();
    const payload = {
      event: 'some.future.event',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: { foo: 'bar' },
    };

    const req1 = makeEventRequest(payload);
    const req2 = makeEventRequest(payload);

    const first = await routeEvent(req1, env as any, ctx);
    expect(first.status).toBe(200);

    const second = await routeEvent(req2, env as any, ctx);
    expect(second.status).toBe(409);
    const body = await second.json() as any;
    expect(body.error).toContain('Duplicate event');
  });

  it('dedupes by explicit x-event-id across different payload bodies', async () => {
    const ctx = createMockCtx();
    const eventId = 'evt-123';

    const req1 = new Request('https://test.workers.dev/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'cf-worker': 'visibility-analytics',
        'x-event-id': eventId,
      },
      body: JSON.stringify({
        event: 'some.future.event',
        source: 'visibility-analytics',
        timestamp: new Date().toISOString(),
        data: { foo: 'bar-a' },
      }),
    });

    const req2 = new Request('https://test.workers.dev/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'cf-worker': 'visibility-analytics',
        'x-event-id': eventId,
      },
      body: JSON.stringify({
        event: 'some.future.event',
        source: 'visibility-analytics',
        timestamp: new Date().toISOString(),
        data: { foo: 'bar-b' },
      }),
    });

    const first = await routeEvent(req1, env as any, ctx);
    expect(first.status).toBe(200);

    const second = await routeEvent(req2, env as any, ctx);
    expect(second.status).toBe(409);
    const body = await second.json() as any;
    expect(body.error).toContain('Duplicate event');
  });

  it('allows absent authority context in enforce mode (legacy compatibility)', async () => {
    env.GOVERNANCE_INGRESS_MODE = 'enforce';
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'some.future.event',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: { tenantId: 'default', foo: 'legacy' },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
  });

  it('allows valid forwarded authority context in enforce mode', async () => {
    env.GOVERNANCE_INGRESS_MODE = 'enforce';
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'some.future.event',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      authorityContext: {
        decisionId: 'dec-valid-1',
        source: 'visibility-analytics',
        allowed: true,
        actorTenantId: 'default',
        targetTenantId: 'default',
      },
      data: { tenantId: 'default', actionType: 'campaign.start' },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
  });

  it('observes but does not block invalid forwarded authority context in observe mode', async () => {
    env.GOVERNANCE_INGRESS_MODE = 'observe';
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'some.future.event',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      authorityContext: {
        source: 'visibility-analytics',
        allowed: true,
      },
      data: { tenantId: 'default' },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
  });

  it('blocks invalid forwarded authority context in enforce mode', async () => {
    env.GOVERNANCE_INGRESS_MODE = 'enforce';
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'some.future.event',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      authorityContext: {
        source: 'visibility-analytics',
        allowed: true,
      },
      data: { tenantId: 'default' },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(403);
  });

  it('blocks untrusted forwarded authority source in enforce mode', async () => {
    env.GOVERNANCE_INGRESS_MODE = 'enforce';
    env.GOVERNANCE_ALLOWED_AUTHORITY_SOURCES = 'visibility-analytics';
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'some.future.event',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      authorityContext: {
        decisionId: 'dec-source-bad',
        source: 'rogue-forwarder',
        allowed: true,
        targetTenantId: 'default',
      },
      data: { tenantId: 'default', actionType: 'campaign.start' },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(403);
  });

  it('enforce mode can be scoped to high-risk actions only', async () => {
    env.GOVERNANCE_INGRESS_MODE = 'enforce';
    env.GOVERNANCE_ENFORCE_ACTIONS = 'send_via_skrip';
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'some.future.event',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      authorityContext: {
        source: 'visibility-analytics',
        allowed: true,
      },
      data: { tenantId: 'default', actionType: 'campaign.start' },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
  });

  it('blocks tenant scope mismatch in enforce mode', async () => {
    env.GOVERNANCE_INGRESS_MODE = 'enforce';
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'some.future.event',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      authorityContext: {
        decisionId: 'dec-tenant-mismatch',
        source: 'visibility-analytics',
        allowed: true,
        targetTenantId: 'tenant-b',
      },
      data: { tenantId: 'tenant-a' },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(403);
  });

  it('suppresses duplicate forwarded authority decision idempotently', async () => {
    env.GOVERNANCE_INGRESS_MODE = 'enforce';
    const ctx = createMockCtx();
    const payload = {
      event: 'some.future.event',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      authorityContext: {
        decisionId: 'dec-dup-1',
        source: 'visibility-analytics',
        allowed: true,
        targetTenantId: 'default',
      },
      data: { tenantId: 'default', actionType: 'campaign.start', foo: 'a' },
    };

    const first = await routeEvent(makeEventRequest(payload), env as any, ctx);
    expect(first.status).toBe(200);

    const second = await routeEvent(makeEventRequest({
      ...payload,
      timestamp: new Date(Date.now() + 1_000).toISOString(),
      data: { tenantId: 'default', actionType: 'campaign.start', foo: 'b' },
    }), env as any, ctx);
    expect(second.status).toBe(200);
    const body = await second.json() as any;
    expect(body.duplicateSuppressed).toBe(true);

    const governanceWrites = env.DB._queries.filter((q) =>
      /INSERT INTO governance_ingress_decisions/.test(q.sql)
    );
    expect(governanceWrites).toHaveLength(2);
  });

  it('routes user.signup events to handleUserSignup', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'user.signup',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: { userId: 'new@test.com', provider: 'google', affiliateCode: 'aff-ref' },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.event).toBe('user.signup');
  });

  it('returns 500 for malformed JSON', async () => {
    const ctx = createMockCtx();
    const req = new Request('https://test.workers.dev/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json{{{',
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(500);
  });

  // ─── Share Event Routing ────────────────────────────────────────────

  it('routes share.created events', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'share.created',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {
        category: 'share',
        plgStage: 'awareness',
        pqlScoreHint: 5,
        owner: 'owner@test.com',
        token: 'vs_abc123',
        scopes: ['pulse', 'action'],
        role: 'viewer',
        tier: 'pro',
      },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.event).toBe('share.created');
  });

  it('routes share.viewed events', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'share.viewed',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {
        category: 'share',
        plgStage: 'activation',
        pqlScoreHint: 10,
        token: 'vs_abc123',
        accessCount: 1,
        scopes: ['pulse'],
      },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.event).toBe('share.viewed');
  });

  it('routes share.engaged events', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'share.engaged',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {
        category: 'share',
        plgStage: 'engagement',
        pqlScoreHint: 15,
        token: 'vs_abc123',
        dwellSeconds: 60,
      },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.event).toBe('share.engaged');
  });

  it('routes share.cta_clicked events', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'share.cta_clicked',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {
        category: 'share',
        plgStage: 'intent',
        pqlScoreHint: 30,
        token: 'vs_abc123',
        dwellSeconds: 90,
      },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.event).toBe('share.cta_clicked');
  });

  it('routes share.converted events', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'share.converted',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {
        category: 'share',
        plgStage: 'conversion',
        pqlScoreHint: 100,
        shareToken: 'vs_abc123',
        newUserId: 'newuser@test.com',
      },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.event).toBe('share.converted');
  });

  it('routes share.revoked events', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'share.revoked',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {
        category: 'share',
        plgStage: 'lifecycle',
        pqlScoreHint: 0,
        owner: 'owner@test.com',
        token: 'vs_abc123',
      },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.event).toBe('share.revoked');
  });

  // ─── Plan Lifecycle + Trial + Insight Event Routing ─────────────────

  it('routes plan.upgraded events', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'plan.upgraded',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {
        userId: 'upgrade@test.com',
        previousPlan: 'starter',
        newPlan: 'growth',
        amountCents: 4900,
        gateway: 'stripe',
        period: 'monthly',
      },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.event).toBe('plan.upgraded');
  });

  it('routes plan.downgraded events', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'plan.downgraded',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {
        userId: 'downgrade@test.com',
        previousPlan: 'pro',
        newPlan: 'starter',
        amountCents: 1900,
        gateway: 'stripe',
        period: 'monthly',
      },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.event).toBe('plan.downgraded');
  });

  it('routes trial.expiring events', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'trial.expiring',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {
        userId: 'trial@test.com',
        plan: 'growth',
        daysRemaining: 2,
        expiresAt: new Date(Date.now() + 2 * 86400 * 1000).toISOString(),
      },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.event).toBe('trial.expiring');
  });

  it('routes insight.generated events', async () => {
    const ctx = createMockCtx();
    const req = makeEventRequest({
      event: 'insight.generated',
      source: 'visibility-analytics',
      timestamp: new Date().toISOString(),
      data: {
        userId: 'site@test.com',
        insightCount: 3,
        topInsightType: 'content_decay',
        severity: 'warning',
      },
    });

    const res = await routeEvent(req, env as any, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.event).toBe('insight.generated');
  });
});
