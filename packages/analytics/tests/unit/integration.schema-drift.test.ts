import { describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { createEnv, makeRequest, MockD1, signUserContext } from './integration.test-helpers';

const CONTRACT = {
  authMe: ['id', 'email', 'name', 'subscriptionTier'],
  site: ['id', 'domain', 'healthScore', 'domainAuthority', 'contentStrength', 'technicalHealth', 'trafficPotential', 'lastAnalyzed'],
  reportData: ['domain', 'healthScore', 'domainAuthority', 'contentStrength', 'technicalHealth', 'trafficPotential', 'lastUpdated'],
} as const;

describe('analytics contract drift checks', () => {
  it('keeps /api/auth/me response aligned with expected contract fields', async () => {
    const env = createEnv();
    const userId = 'u-1';
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signUserContext(env.ANALYTICS_USER_AUTH_SECRET as string, userId, ts);
    (env.VISIBILITY_DB as unknown as MockD1).onQuery(
      /SELECT id, email, name, subscription_tier FROM users/i,
      { id: 'u-1', email: 'u1@test.com', name: 'User One', subscription_tier: 'pro' },
    );

    const res = await worker.fetch(
      makeRequest('/api/auth/me', {
        headers: {
          Authorization: 'Bearer admin-test-token',
          'x-user-id': userId,
          'x-user-ts': String(ts),
          'x-user-sig': sig,
        },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    for (const key of CONTRACT.authMe) {
      expect(Object.prototype.hasOwnProperty.call(body, key)).toBe(true);
    }
  });

  it('keeps /api/sites mapped field names aligned with contract', async () => {
    const env = createEnv();
    const userId = 'u-1';
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signUserContext(env.ANALYTICS_USER_AUTH_SECRET as string, userId, ts);
    (env.VISIBILITY_DB as unknown as MockD1).onQuery(
      /SELECT id, domain, health_score, domain_authority, content_strength, technical_health, traffic_potential, last_analyzed_at/i,
      undefined,
      [
        {
          id: 's-1',
          domain: 'example.com',
          health_score: 81,
          domain_authority: 55,
          content_strength: 79,
          technical_health: 83,
          traffic_potential: 62,
          last_analyzed_at: 1735689600,
        },
      ],
    );

    const res = await worker.fetch(
      makeRequest('/api/sites', {
        headers: {
          Authorization: 'Bearer admin-test-token',
          'x-user-id': userId,
          'x-user-ts': String(ts),
          'x-user-sig': sig,
        },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { sites: Array<Record<string, unknown>> };
    expect(body.sites).toHaveLength(1);
    for (const key of CONTRACT.site) {
      expect(Object.prototype.hasOwnProperty.call(body.sites[0], key)).toBe(true);
    }
  });

  it('keeps /internal/report-data response aligned with contract', async () => {
    const env = createEnv();
    (env.VISIBILITY_DB as unknown as MockD1).onQuery(
      /SELECT domain, health_score, domain_authority, content_strength, technical_health, traffic_potential, last_analyzed_at/i,
      {
        domain: 'example.com',
        health_score: 75,
        domain_authority: 68,
        content_strength: 82,
        technical_health: 71,
        traffic_potential: 60,
        last_analyzed_at: 1735689600,
      },
    );

    const res = await worker.fetch(
      makeRequest('/internal/report-data/example.com', {
        headers: { 'x-system-token': 'system-test-token' },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    for (const key of CONTRACT.reportData) {
      expect(Object.prototype.hasOwnProperty.call(body, key)).toBe(true);
    }
  });
});
