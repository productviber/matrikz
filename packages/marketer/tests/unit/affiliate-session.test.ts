import { describe, it, expect } from 'vitest';
import { createMockEnv, makeRequest } from '../helpers';
import {
  issueAffiliateSessionToken,
  verifyAffiliateSessionToken,
  resolveAffiliateIdentity,
} from '../../src/lib/affiliate-session';

describe('affiliate session tokens', () => {
  it('issues and verifies a token', async () => {
    const env = createMockEnv({ AFFILIATE_AUTH_SECRET: 'secret-1' as any });
    const issued = await issueAffiliateSessionToken(env as any, 'AFF123', 'owner@test.com', 900);

    const identity = await verifyAffiliateSessionToken(env as any, issued.token);
    expect(identity).toEqual({ code: 'AFF123', email: 'owner@test.com' });
  });

  it('rejects tokens with wrong secret', async () => {
    const env = createMockEnv({ AFFILIATE_AUTH_SECRET: 'secret-1' as any });
    const issued = await issueAffiliateSessionToken(env as any, 'AFF123', 'owner@test.com', 900);

    const envWrong = createMockEnv({ AFFILIATE_AUTH_SECRET: 'secret-2' as any });
    const identity = await verifyAffiliateSessionToken(envWrong as any, issued.token);
    expect(identity).toBeNull();
  });

  it('resolves identity from bearer token in strong-auth mode', async () => {
    const env = createMockEnv({ AFFILIATE_AUTH_SECRET: 'secret-1' as any });
    const issued = await issueAffiliateSessionToken(env as any, 'AFF123', 'owner@test.com', 900);

    const req = makeRequest('GET', '/api/affiliate/portal', undefined, {
      Authorization: `Bearer ${issued.token}`,
    });

    const identity = await resolveAffiliateIdentity(req, env as any);
    expect(identity).toEqual({ code: 'AFF123', email: 'owner@test.com' });
  });

  it('falls back to query params in legacy mode', async () => {
    const env = createMockEnv({ AFFILIATE_AUTH_SECRET: undefined as any });
    const req = makeRequest('GET', '/api/affiliate/portal?code=AFF123&email=owner@test.com');

    const identity = await resolveAffiliateIdentity(req, env as any);
    expect(identity).toEqual({ code: 'AFF123', email: 'owner@test.com' });
  });
});
