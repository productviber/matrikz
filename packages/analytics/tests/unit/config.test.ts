import { describe, it, expect } from 'vitest';
import worker, { type Bindings } from '../../src/index';

function makeEnv(overrides: Partial<Bindings> = {}): Bindings {
  return {
    VISIBILITY_DB: {} as Bindings['VISIBILITY_DB'],
    ANALYTICS_CACHE: {} as Bindings['ANALYTICS_CACHE'],
    ENVIRONMENT: 'development',
    SYSTEM_TOKEN: 'system-token',
    ADMIN_TOKEN: 'admin-token',
    ANALYTICS_USER_AUTH_SECRET: 'user-secret',
    ...overrides,
  };
}

describe('analytics startup config validation', () => {
  it('returns 503 in production when signed user auth secret is missing', async () => {
    const env = makeEnv({ ENVIRONMENT: 'production', ANALYTICS_USER_AUTH_SECRET: undefined });
    const res = await worker.fetch(new Request('https://analytics.local/health'), env);
    expect(res.status).toBe(503);
  });

  it('returns 503 in production when system/admin token is missing', async () => {
    const env = makeEnv({ ENVIRONMENT: 'production', SYSTEM_TOKEN: undefined, ADMIN_TOKEN: undefined });
    const res = await worker.fetch(new Request('https://analytics.local/health'), env);
    expect(res.status).toBe(503);
  });
});
