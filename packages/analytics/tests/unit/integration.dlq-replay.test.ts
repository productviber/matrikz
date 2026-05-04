import { describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { createEnv, makeRequest, MockD1, signUserContext } from './integration.test-helpers';

describe('analytics auth/replay-safety scaffolding', () => {
  it('requires signed user context for /api/auth/me', async () => {
    const env = createEnv();
    const res = await worker.fetch(
      makeRequest('/api/auth/me', {
        headers: { Authorization: 'Bearer admin-test-token' },
      }),
      env,
    );

    expect(res.status).toBe(401);
  });

  it('rejects invalid user signature for /api/auth/me', async () => {
    const env = createEnv();
    const ts = Math.floor(Date.now() / 1000);
    const res = await worker.fetch(
      makeRequest('/api/auth/me', {
        headers: {
          Authorization: 'Bearer admin-test-token',
          'x-user-id': 'u-1',
          'x-user-ts': String(ts),
          'x-user-sig': 'deadbeef',
        },
      }),
      env,
    );

    expect(res.status).toBe(401);
  });

  it('returns 404 for valid signature when user row is absent', async () => {
    const env = createEnv();
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signUserContext(env.ANALYTICS_USER_AUTH_SECRET as string, 'u-404', ts);
    const res = await worker.fetch(
      makeRequest('/api/auth/me', {
        headers: {
          Authorization: 'Bearer admin-test-token',
          'x-user-id': 'u-404',
          'x-user-ts': String(ts),
          'x-user-sig': sig,
        },
      }),
      env,
    );

    expect(res.status).toBe(404);
  });

  it('returns user payload for valid signature and existing user row', async () => {
    const env = createEnv();
    const ts = Math.floor(Date.now() / 1000);
    const userId = 'u-1';
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
    expect(body.id).toBe('u-1');
    expect(body.subscriptionTier).toBe('pro');
  });
});
