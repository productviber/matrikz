import { describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { createEnv, makeRequest, MockD1 } from './integration.test-helpers';

describe('analytics integration event ingress scaffolding', () => {
  it('returns 501 for explicit not-implemented click ingest route', async () => {
    const env = createEnv();
    const res = await worker.fetch(
      makeRequest('/api/v1/events/click', {
        method: 'POST',
        body: JSON.stringify({ eventId: 'evt_1' }),
      }),
      env,
    );

    expect(res.status).toBe(501);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Not implemented');
  });

  it('returns 404 for unsupported /events route in current worker surface', async () => {
    const env = createEnv();
    const res = await worker.fetch(
      makeRequest('/events', {
        method: 'POST',
        body: JSON.stringify({ eventId: 'evt_2', source: 'visibility-analytics' }),
      }),
      env,
    );

    expect(res.status).toBe(404);
  });

  it('requires auth for internal report route', async () => {
    const env = createEnv();
    const res = await worker.fetch(makeRequest('/internal/report-data/example.com'), env);
    expect(res.status).toBe(401);
  });

  it('validates domain parameter for internal report route', async () => {
    const env = createEnv();
    const res = await worker.fetch(
      makeRequest('/internal/report-data/%20', {
        headers: { 'x-system-token': 'system-test-token' },
      }),
      env,
    );

    expect(res.status).toBe(400);
  });

  it('returns 404 when report data is not found', async () => {
    const env = createEnv();
    const res = await worker.fetch(
      makeRequest('/internal/report-data/missing.example', {
        headers: { 'x-system-token': 'system-test-token' },
      }),
      env,
    );

    expect(res.status).toBe(404);
  });

  it('returns normalized report payload when site row exists', async () => {
    const env = createEnv();
    (env.VISIBILITY_DB as unknown as MockD1).onQuery(
      /SELECT domain, health_score, domain_authority, content_strength, technical_health, traffic_potential, last_analyzed_at/i,
      {
        domain: 'example.com',
        health_score: 78,
        domain_authority: 55,
        content_strength: 66,
        technical_health: 81,
        traffic_potential: 72,
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
    expect(body.domain).toBe('example.com');
    expect(body.healthScore).toBe(78);
    expect(body.domainAuthority).toBe(55);
  });
});
