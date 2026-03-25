import { describe, it, expect } from 'vitest';
import {
  requireAdmin,
  requireAgentic,
  requireSystem,
  requireUser,
  requireWebhook,
} from '../../src/lib/auth.ts';
import { createMockEnv, makeRequest } from '../helpers';

describe('shared auth module', () => {
  it('returns response for failed admin auth', () => {
    const env = createMockEnv();
    const req = makeRequest('GET', '/api/admin/dashboard');
    const result = requireAdmin(req, env as any);

    expect(result.ok).toBe(false);
    expect(result.response).toBeTruthy();
    expect(result.decision.lane).toBe('admin');
  });

  it('allows agentic lane with configured token', () => {
    const env = createMockEnv({ AGENT_TOKEN: 'agent-secret' });
    const req = makeRequest('POST', '/api/admin/emails/process', undefined, {
      'x-agent-token': 'agent-secret',
    });
    const result = requireAgentic(req, env as any);
    expect(result.ok).toBe(true);
    expect(result.response).toBeNull();
  });

  it('allows webhook lane when no token configured', () => {
    const env = createMockEnv({ WEBHOOK_TOKEN: undefined });
    const req = makeRequest('POST', '/webhooks/brevo');
    const result = requireWebhook(req, env as any);
    expect(result.ok).toBe(true);
  });

  it('allows system lane using explicit system token', () => {
    const env = createMockEnv({ SYSTEM_TOKEN: 'sys-token' });
    const req = makeRequest('POST', '/events', undefined, {
      'x-system-token': 'sys-token',
    });
    const result = requireSystem(req, env as any, 'visibility-analytics');
    expect(result.ok).toBe(true);
  });

  it('allows user lane for unsubscribe public endpoint', async () => {
    const env = createMockEnv({ AFFILIATE_AUTH_SECRET: 'secret' as any, ENVIRONMENT: 'production' });
    const req = makeRequest('POST', '/api/unsubscribe', { email: 'person@example.com' });
    const result = await requireUser(req, env as any);
    expect(result.ok).toBe(true);
  });
});
