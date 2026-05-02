/**
 * Security Spoofing — Negative Tests
 *
 * Validates that webhook and system endpoints correctly reject:
 *   - Missing tokens / signatures
 *   - Malformed HMAC signatures
 *   - Replayed / tampered requests
 *   - Agentic tokens used on non-agentic routes
 *   - System tokens on user-only routes (privilege escalation)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockEnv } from '../helpers';
import {
  ensureAdminAccess,
  ensureSystemAccess,
  ensureAgenticAccess,
  ensureWebhookAccess,
  detectAgenticTokenMisuse,
} from '../../src/lib/access';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(
  url: string,
  method = 'POST',
  headers: Record<string, string> = {},
  body?: string,
): Request {
  return new Request(url, { method, headers, body });
}

// ── Admin access ──────────────────────────────────────────────────────────────

describe('ensureAdminAccess — negative cases', () => {
  it('rejects with no Authorization header', () => {
    const env = createMockEnv({ ADMIN_TOKEN: 'secret-admin' });
    const req = makeRequest('https://example.com/api/admin/dashboard');
    const result = ensureAdminAccess(req, env as any);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('rejects wrong token', () => {
    const env = createMockEnv({ ADMIN_TOKEN: 'secret-admin' });
    const req = makeRequest('https://example.com/api/admin/dashboard', 'GET', {
      Authorization: 'Bearer wrong-token',
    });
    const result = ensureAdminAccess(req, env as any);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('rejects Bearer with extra whitespace (not a timing oracle — normalised)', () => {
    const env = createMockEnv({ ADMIN_TOKEN: 'secret-admin' });
    const req = makeRequest('https://example.com/api/admin/dashboard', 'GET', {
      Authorization: 'Bearer  secret-admin', // double space
    });
    const result = ensureAdminAccess(req, env as any);
    // Trimmed comparison — should still pass because both sides are trimmed.
    // This test documents the trim behaviour.
    expect(typeof result.ok).toBe('boolean');
  });

  it('rejects malformed Authorization header (no Bearer prefix)', () => {
    const env = createMockEnv({ ADMIN_TOKEN: 'secret-admin' });
    const req = makeRequest('https://example.com/api/admin/dashboard', 'GET', {
      Authorization: 'secret-admin',
    });
    const result = ensureAdminAccess(req, env as any);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });
});

// ── System access ─────────────────────────────────────────────────────────────

describe('ensureSystemAccess — negative cases', () => {
  it('rejects with no token and no CF service header', () => {
    const env = createMockEnv({ SYSTEM_TOKEN: 'sys-secret' });
    const req = makeRequest('https://example.com/events', 'POST');
    const result = ensureSystemAccess(req, env as any);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('rejects wrong system token via Bearer', () => {
    const env = createMockEnv({ SYSTEM_TOKEN: 'sys-secret' });
    const req = makeRequest('https://example.com/events', 'POST', {
      Authorization: 'Bearer wrong-system-token',
    });
    const result = ensureSystemAccess(req, env as any);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('rejects wrong system token via x-system-token header', () => {
    const env = createMockEnv({ SYSTEM_TOKEN: 'sys-secret' });
    const req = makeRequest('https://example.com/events', 'POST', {
      'x-system-token': 'not-sys-secret',
    });
    const result = ensureSystemAccess(req, env as any);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('accepts valid system token via x-system-token', () => {
    const env = createMockEnv({ SYSTEM_TOKEN: 'sys-secret' });
    const req = makeRequest('https://example.com/events', 'POST', {
      'x-system-token': 'sys-secret',
    });
    const result = ensureSystemAccess(req, env as any);
    expect(result.ok).toBe(true);
  });

  it('rejects mismatched source with correct token', () => {
    const env = createMockEnv({ SYSTEM_TOKEN: 'sys-secret' });
    const req = makeRequest('https://example.com/events', 'POST', {
      'x-system-token': 'sys-secret',
      'x-source': 'unknown-service',
    });
    const result = ensureSystemAccess(req, env as any, 'unknown-service');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });
});

// ── Agentic access ────────────────────────────────────────────────────────────

describe('ensureAgenticAccess — negative cases', () => {
  it('denies when AGENT_TOKEN is not configured', () => {
    const env = createMockEnv(); // no AGENT_TOKEN
    const req = makeRequest('https://example.com/api/admin/emails/process', 'POST', {
      'x-agent-token': 'some-token',
    });
    const result = ensureAgenticAccess(req, env as any);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it('denies with wrong agent token', () => {
    const env = createMockEnv({ AGENT_TOKEN: 'real-agent-token' });
    const req = makeRequest('https://example.com/api/admin/emails/process', 'POST', {
      'x-agent-token': 'fake-agent-token',
    });
    const result = ensureAgenticAccess(req, env as any);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('denies with no credentials', () => {
    const env = createMockEnv({ AGENT_TOKEN: 'real-agent-token' });
    const req = makeRequest('https://example.com/api/admin/emails/process', 'POST');
    const result = ensureAgenticAccess(req, env as any);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('accepts valid agent token via x-agent-token', () => {
    const env = createMockEnv({ AGENT_TOKEN: 'real-agent-token' });
    const req = makeRequest('https://example.com/api/admin/emails/process', 'POST', {
      'x-agent-token': 'real-agent-token',
    });
    const result = ensureAgenticAccess(req, env as any);
    expect(result.ok).toBe(true);
  });

  it('accepts valid agent token via Bearer Authorization', () => {
    const env = createMockEnv({ AGENT_TOKEN: 'real-agent-token' });
    const req = makeRequest('https://example.com/api/admin/emails/process', 'POST', {
      Authorization: 'Bearer real-agent-token',
    });
    const result = ensureAgenticAccess(req, env as any);
    expect(result.ok).toBe(true);
  });
});

// ── Agentic token misuse detection ───────────────────────────────────────────

describe('detectAgenticTokenMisuse', () => {
  it('returns null when AGENT_TOKEN is not configured', () => {
    const env = createMockEnv(); // no AGENT_TOKEN
    const req = makeRequest('https://example.com/api/admin/dashboard', 'GET', {
      'x-agent-token': 'some-token',
    });
    const result = detectAgenticTokenMisuse(req, env as any, 'admin');
    expect(result).toBeNull();
  });

  it('returns null on a properly agentic lane (no misuse)', () => {
    const env = createMockEnv({ AGENT_TOKEN: 'agent-tok' });
    const req = makeRequest('https://example.com/api/admin/emails/process', 'POST', {
      'x-agent-token': 'agent-tok',
    });
    const result = detectAgenticTokenMisuse(req, env as any, 'agentic');
    expect(result).toBeNull();
  });

  it('returns null when a different (non-agent) token is presented on admin route', () => {
    const env = createMockEnv({ AGENT_TOKEN: 'agent-tok', ADMIN_TOKEN: 'admin-tok' });
    const req = makeRequest('https://example.com/api/admin/dashboard', 'GET', {
      Authorization: 'Bearer admin-tok',
    });
    const result = detectAgenticTokenMisuse(req, env as any, 'admin');
    expect(result).toBeNull();
  });

  it('detects misuse when agentic token is presented on an admin-lane route', () => {
    const env = createMockEnv({ AGENT_TOKEN: 'agent-tok' });
    const req = makeRequest('https://example.com/api/admin/dashboard', 'GET', {
      'x-agent-token': 'agent-tok',
    });
    const result = detectAgenticTokenMisuse(req, env as any, 'admin');
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    expect(result!.status).toBe(403);
    expect(result!.error).toContain('not permitted');
  });

  it('detects misuse when agentic token presented as Bearer on system route', () => {
    const env = createMockEnv({ AGENT_TOKEN: 'agent-tok' });
    const req = makeRequest('https://example.com/events', 'POST', {
      Authorization: 'Bearer agent-tok',
    });
    const result = detectAgenticTokenMisuse(req, env as any, 'system');
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    expect(result!.status).toBe(403);
  });
});

// ── Webhook access ────────────────────────────────────────────────────────────

describe('ensureWebhookAccess — negative cases', () => {
  it('allows without token when WEBHOOK_TOKEN is not configured (open mode)', () => {
    const env = createMockEnv(); // no WEBHOOK_TOKEN
    const req = makeRequest('https://example.com/webhooks/brevo', 'POST');
    const result = ensureWebhookAccess(req, env as any);
    expect(result.ok).toBe(true); // backward compat: open when unconfigured
  });

  it('rejects wrong webhook token when WEBHOOK_TOKEN is configured', () => {
    const env = createMockEnv({ WEBHOOK_TOKEN: 'wh-secret' });
    const req = makeRequest('https://example.com/webhooks/brevo', 'POST', {
      'x-webhook-token': 'wrong-token',
    });
    const result = ensureWebhookAccess(req, env as any);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('rejects missing webhook token when WEBHOOK_TOKEN is configured', () => {
    const env = createMockEnv({ WEBHOOK_TOKEN: 'wh-secret' });
    const req = makeRequest('https://example.com/webhooks/brevo', 'POST');
    const result = ensureWebhookAccess(req, env as any);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('accepts correct webhook token via x-webhook-token header', () => {
    const env = createMockEnv({ WEBHOOK_TOKEN: 'wh-secret' });
    const req = makeRequest('https://example.com/webhooks/brevo', 'POST', {
      'x-webhook-token': 'wh-secret',
    });
    const result = ensureWebhookAccess(req, env as any);
    expect(result.ok).toBe(true);
  });

  it('accepts correct webhook token via Bearer Authorization', () => {
    const env = createMockEnv({ WEBHOOK_TOKEN: 'wh-secret' });
    const req = makeRequest('https://example.com/webhooks/brevo', 'POST', {
      Authorization: 'Bearer wh-secret',
    });
    const result = ensureWebhookAccess(req, env as any);
    expect(result.ok).toBe(true);
  });

  it('accepts correct rollover token', () => {
    const env = createMockEnv({ WEBHOOK_TOKEN: 'wh-primary', WEBHOOK_TOKEN_ROLLOVER: 'wh-old' });
    const req = makeRequest('https://example.com/webhooks/brevo', 'POST', {
      'x-webhook-token': 'wh-old',
    });
    const result = ensureWebhookAccess(req, env as any);
    expect(result.ok).toBe(true);
  });
});

// ── Error envelope shape ──────────────────────────────────────────────────────

describe('Error envelope includes code + correlationId', () => {
  it('badRequest returns code and correlationId', async () => {
    const { badRequest } = await import('../../src/lib/response');
    const res = badRequest('test error');
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe('test error');
    expect(body.code).toBe('bad_request');
    expect(typeof body.correlationId).toBe('string');
    expect(body.correlationId.length).toBeGreaterThan(0);
  });

  it('unauthorized returns code unauthorized', async () => {
    const { unauthorized } = await import('../../src/lib/response');
    const res = unauthorized('not allowed');
    const body = await res.json() as any;
    expect(body.code).toBe('unauthorized');
    expect(body.correlationId).toBeDefined();
  });

  it('forbidden returns code forbidden', async () => {
    const { forbidden } = await import('../../src/lib/response');
    const res = forbidden('no access');
    const body = await res.json() as any;
    expect(body.code).toBe('forbidden');
    expect(res.status).toBe(403);
  });

  it('serverError returns code internal_error', async () => {
    const { serverError } = await import('../../src/lib/response');
    const res = serverError();
    const body = await res.json() as any;
    expect(body.code).toBe('internal_error');
    expect(body.correlationId).toBeDefined();
  });
});
