import { describe, it, expect, beforeEach } from 'vitest';
import { handleGovernanceIngressSlo } from '../../src/routes/admin';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';

describe('handleGovernanceIngressSlo()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
    env.DB.onQuery(/SELECT COUNT\(\*\) AS total[\s\S]*FROM governance_ingress_decisions/i, () => [{
      total: 10,
      allowed_count: 8,
      blocked_count: 1,
      observed_count: 6,
      bypassed_count: 1,
      duplicate_suppressed_count: 1,
      violation_count: 3,
    }]);
    env.DB.onQuery(/SELECT COALESCE\(authority_source, 'absent_or_legacy'\) AS source/i, () => [
      { source: 'visibility-analytics', count: 6 },
      { source: 'absent_or_legacy', count: 4 },
    ]);
    env.DB.onQuery(/SELECT reason AS source/i, () => [
      { source: 'authority_context_valid', count: 7 },
      { source: 'authority_context_absent', count: 2 },
      { source: 'authority_context_missing_decision_id', count: 1 },
    ]);
    env.DB.onQuery(/SELECT enforcement_outcome AS source/i, () => [
      { source: 'observed', count: 6 },
      { source: 'blocked', count: 1 },
      { source: 'bypassed', count: 1 },
      { source: 'duplicate_suppressed', count: 1 },
      { source: 'allowed', count: 1 },
    ]);
  });

  it('returns governance ingress SLO summary with rates', async () => {
    const req = makeRequest('GET', '/api/admin/governance/ingress-slo?hours=24');
    const res = await handleGovernanceIngressSlo(req, env as any);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    const data = body.data ?? body;
    expect(data.window.hours).toBe(24);
    expect(data.totals.events).toBe(10);
    expect(data.totals.blocked).toBe(1);
    expect(data.totals.violations).toBe(3);
    expect(data.rates.passRate).toBeCloseTo(0.8, 5);
    expect(data.sourceDistribution['visibility-analytics']).toBe(6);
    expect(data.reasonDistribution['authority_context_valid']).toBe(7);
    expect(data.enforcementOutcomeDistribution.observed).toBe(6);
  });

  it('applies tenant scope filter and bounded hours', async () => {
    const req = makeRequest('GET', '/api/admin/governance/ingress-slo?hours=9999&tenantId=default&source=visibility-analytics&reason=authority_context_valid&mode=observe&actionType=campaign.start');
    const res = await handleGovernanceIngressSlo(req, env as any);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    const data = body.data ?? body;
    expect(data.window.hours).toBe(720);
    expect(data.scope.tenantId).toBe('default');
    expect(data.scope.source).toBe('visibility-analytics');
    expect(data.scope.reason).toBe('authority_context_valid');
    expect(data.scope.mode).toBe('observe');
    expect(data.scope.actionType).toBe('campaign.start');
  });
});
