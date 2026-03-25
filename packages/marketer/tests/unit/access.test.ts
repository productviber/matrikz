import { describe, it, expect } from 'vitest';
import {
  ensureAdminAccess,
  ensureSystemAccess,
  ensureWebhookAccess,
  ensureAgenticAccess,
  ensureUserAccess,
  accessDenied,
} from '../../src/lib/access.ts';
import { createMockEnv, makeRequest } from '../helpers';
import { CF_SERVICE_HEADER, TRUSTED_SOURCE } from '../../src/constants';
import { issueAffiliateSessionToken } from '../../src/lib/affiliate-session.ts';

describe('access guards', () => {
  describe('ensureAdminAccess()', () => {
    it('denies when bearer token is missing', () => {
      const env = createMockEnv();
      const req = makeRequest('GET', '/api/admin/dashboard');
      const decision = ensureAdminAccess(req, env as any);
      expect(decision.ok).toBe(false);
      expect(decision.status).toBe(401);
      expect(decision.lane).toBe('admin');
    });

    it('allows when bearer token is valid', () => {
      const env = createMockEnv();
      const req = makeRequest('GET', '/api/admin/dashboard', undefined, {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
      });
      const decision = ensureAdminAccess(req, env as any);
      expect(decision.ok).toBe(true);
      expect(decision.lane).toBe('admin');
    });

    it('allows rollover admin token when configured', () => {
      const env = createMockEnv({ ADMIN_TOKEN_ROLLOVER: 'old-admin-token' as any });
      const req = makeRequest('GET', '/api/admin/dashboard', undefined, {
        Authorization: 'Bearer old-admin-token',
      });
      const decision = ensureAdminAccess(req, env as any);
      expect(decision.ok).toBe(true);
    });

    it('denies malformed Authorization header format', () => {
      const env = createMockEnv();
      const req = makeRequest('GET', '/api/admin/dashboard', undefined, {
        Authorization: `Basic ${btoa('foo:bar')}`,
      });
      const decision = ensureAdminAccess(req, env as any);
      expect(decision.ok).toBe(false);
      expect(decision.status).toBe(401);
    });

    it('denies empty bearer token', () => {
      const env = createMockEnv();
      const req = makeRequest('GET', '/api/admin/dashboard', undefined, {
        Authorization: 'Bearer   ',
      });
      const decision = ensureAdminAccess(req, env as any);
      expect(decision.ok).toBe(false);
      expect(decision.status).toBe(401);
    });
  });

  describe('ensureSystemAccess()', () => {
    it('allows trusted service-binding requests', () => {
      const env = createMockEnv();
      const req = makeRequest('POST', '/events', undefined, {
        [CF_SERVICE_HEADER]: 'visibility-analytics',
      });
      const decision = ensureSystemAccess(req, env as any, TRUSTED_SOURCE);
      expect(decision.ok).toBe(true);
      expect(decision.lane).toBe('system');
    });

    it('denies service-binding request with unknown source', () => {
      const env = createMockEnv();
      const req = makeRequest('POST', '/events', undefined, {
        [CF_SERVICE_HEADER]: 'visibility-analytics',
      });
      const decision = ensureSystemAccess(req, env as any, 'unknown-source');
      expect(decision.ok).toBe(false);
      expect(decision.status).toBe(400);
    });

    it('allows explicit system token when configured', () => {
      const env = createMockEnv({ SYSTEM_TOKEN: 'system-secret' });
      const req = makeRequest('POST', '/events', undefined, {
        'x-system-token': 'system-secret',
      });
      const decision = ensureSystemAccess(req, env as any, TRUSTED_SOURCE);
      expect(decision.ok).toBe(true);
    });

    it('denies when token path is used but system token is invalid', () => {
      const env = createMockEnv({ SYSTEM_TOKEN: 'system-secret' });
      const req = makeRequest('POST', '/events', undefined, {
        'x-system-token': 'wrong-token',
      });
      const decision = ensureSystemAccess(req, env as any, TRUSTED_SOURCE);
      expect(decision.ok).toBe(false);
      expect(decision.status).toBe(401);
    });

    it('allows rollover system token when configured', () => {
      const env = createMockEnv({ SYSTEM_TOKEN: 'new-system', SYSTEM_TOKEN_ROLLOVER: 'old-system' as any });
      const req = makeRequest('POST', '/events', undefined, {
        'x-system-token': 'old-system',
      });
      const decision = ensureSystemAccess(req, env as any, TRUSTED_SOURCE);
      expect(decision.ok).toBe(true);
    });
  });

  describe('ensureWebhookAccess()', () => {
    it('allows when no webhook token is configured', () => {
      const env = createMockEnv({ WEBHOOK_TOKEN: undefined });
      const req = makeRequest('POST', '/webhooks/brevo');
      const decision = ensureWebhookAccess(req, env as any);
      expect(decision.ok).toBe(true);
      expect(decision.lane).toBe('webhook');
    });

    it('denies when webhook token is configured and missing', () => {
      const env = createMockEnv({ WEBHOOK_TOKEN: 'webhook-secret' });
      const req = makeRequest('POST', '/webhooks/brevo');
      const decision = ensureWebhookAccess(req, env as any);
      expect(decision.ok).toBe(false);
      expect(decision.status).toBe(401);
    });

    it('allows when webhook token matches', () => {
      const env = createMockEnv({ WEBHOOK_TOKEN: 'webhook-secret' });
      const req = makeRequest('POST', '/webhooks/brevo', undefined, {
        'x-webhook-token': 'webhook-secret',
      });
      const decision = ensureWebhookAccess(req, env as any);
      expect(decision.ok).toBe(true);
    });

    it('allows rollover webhook token when configured', () => {
      const env = createMockEnv({ WEBHOOK_TOKEN: 'new-webhook', WEBHOOK_TOKEN_ROLLOVER: 'old-webhook' as any });
      const req = makeRequest('POST', '/webhooks/brevo', undefined, {
        'x-webhook-token': 'old-webhook',
      });
      const decision = ensureWebhookAccess(req, env as any);
      expect(decision.ok).toBe(true);
    });
  });

  describe('ensureAgenticAccess()', () => {
    it('denies when agentic lane is not configured', () => {
      const env = createMockEnv({ AGENT_TOKEN: undefined });
      const req = makeRequest('POST', '/api/admin/emails/process');
      const decision = ensureAgenticAccess(req, env as any);
      expect(decision.ok).toBe(false);
      expect(decision.status).toBe(503);
    });

    it('allows when x-agent-token is valid', () => {
      const env = createMockEnv({ AGENT_TOKEN: 'agent-secret' });
      const req = makeRequest('POST', '/api/admin/emails/process', undefined, {
        'x-agent-token': 'agent-secret',
      });
      const decision = ensureAgenticAccess(req, env as any);
      expect(decision.ok).toBe(true);
      expect(decision.lane).toBe('agentic');
    });
  });

  describe('accessDenied()', () => {
    it('returns JSON error envelope with status', async () => {
      const res = accessDenied({
        ok: false,
        lane: 'admin',
        status: 401,
        error: 'Invalid token',
      });
      expect(res.status).toBe(401);
      const body = await res.json() as any;
      expect(body.ok).toBe(false);
      expect(body.error).toBe('Invalid token');
    });
  });

  describe('ensureUserAccess()', () => {
    it('allows legacy development query auth when affiliate secret is missing', async () => {
      const env = createMockEnv({ AFFILIATE_AUTH_SECRET: undefined, ENVIRONMENT: 'development' });
      const req = makeRequest('GET', '/api/affiliate/gdpr/export?code=AFF100&email=a@test.com');
      const decision = await ensureUserAccess(req, env as any);
      expect(decision.ok).toBe(true);
      expect(decision.lane).toBe('user');
    });

    it('denies user lane without signed token when secret is configured', async () => {
      const env = createMockEnv({ AFFILIATE_AUTH_SECRET: 'secret' as any, ENVIRONMENT: 'production' });
      const req = makeRequest('GET', '/api/affiliate/gdpr/export');
      const decision = await ensureUserAccess(req, env as any);
      expect(decision.ok).toBe(false);
      expect(decision.status).toBe(401);
    });

    it('allows user lane with valid affiliate bearer token', async () => {
      const env = createMockEnv({ AFFILIATE_AUTH_SECRET: 'secret' as any, ENVIRONMENT: 'production' });
      const token = await issueAffiliateSessionToken(env as any, 'AFF100', 'owner@test.com');
      const req = makeRequest('GET', '/api/affiliate/gdpr/export', undefined, {
        Authorization: `Bearer ${token.token}`,
      });
      const decision = await ensureUserAccess(req, env as any);
      expect(decision.ok).toBe(true);
      expect(decision.lane).toBe('user');
    });
  });
});
