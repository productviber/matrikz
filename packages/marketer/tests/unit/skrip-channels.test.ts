/**
 * Multi-Channel Subscription Routes — Unit Tests
 *
 * WhatsApp · SMS · Telegram subscribe/unsubscribe handlers.
 * Validates address validation, D1 inserts, Skrip registration non-fatality,
 * and correct HTTP status codes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockEnv } from '../helpers';
import { MockD1Database } from '../helpers';
import { evaluateGovernanceExecution } from '../../src/lib/governance-execution-client';
import {
  handleWhatsAppSubscribe,
  handleWhatsAppUnsubscribe,
  handleSmsSubscribe,
  handleSmsUnsubscribe,
  handleTelegramSubscribe,
  handleTelegramUnsubscribe,
} from '../../src/routes/skrip-channels';

// ── Mock registerContactChannel ───────────────────────────────────────────────

vi.mock('../../src/lib/skrip/registration', () => ({
  registerContactChannel: vi.fn().mockResolvedValue({ registrationState: 'registered' }),
}));

vi.mock('../../src/lib/governance-execution-client', () => ({
  evaluateGovernanceExecution: vi.fn().mockResolvedValue({
    decisionId: 'gexec_test',
    governanceMode: 'off',
    actionType: 'channel.whatsapp.subscribe',
    actorTenantId: 'default',
    targetTenantId: 'default',
    tenantScope: 'default',
    allowed: true,
    enforcementOutcome: 'bypassed',
    reason: 'bypass_mode_off',
    policyVersion: null,
    signedDecisionToken: null,
    violation: false,
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(body: unknown, method = 'POST'): Request {
  return new Request('https://example.com/api/channels/test/subscribe', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(body: unknown): Request {
  return new Request('https://example.com/api/channels/test/unsubscribe', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeEnvWithInsertHandler() {
  const env = createMockEnv();
  env.DB.onQuery(/push_opt_in_events/i, () => []);
  return env;
}

beforeEach(() => {
  vi.clearAllMocks();
  (evaluateGovernanceExecution as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
    decisionId: 'gexec_test',
    governanceMode: 'off',
    actionType: 'channel.test',
    actorTenantId: 'default',
    targetTenantId: 'default',
    tenantScope: 'default',
    allowed: true,
    enforcementOutcome: 'bypassed',
    reason: 'bypass_mode_off',
    policyVersion: null,
    signedDecisionToken: null,
    violation: false,
  });
});

// ── WhatsApp ──────────────────────────────────────────────────────────────────

describe('handleWhatsAppSubscribe', () => {

  it('returns 400 for missing address', async () => {
    const env = makeEnvWithInsertHandler();
    const req = makeRequest({ contactId: 'c1' });
    const res = await handleWhatsAppSubscribe(req, env as any);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
  });

  it('returns 400 for invalid phone number (not E.164)', async () => {
    const env = makeEnvWithInsertHandler();
    const req = makeRequest({ address: '555-1234', contactId: 'c1' });
    const res = await handleWhatsAppSubscribe(req, env as any);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('E.164');
  });

  it('returns 201 for valid E.164 phone number', async () => {
    const env = makeEnvWithInsertHandler();
    const req = makeRequest({ address: '+14155551234', contactId: 'c1' });
    const res = await handleWhatsAppSubscribe(req, env as any);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.channel).toBe('whatsapp');
    expect(body.data.registered).toBe(true);
  });

  it('sets registered=false when no contactId provided', async () => {
    const env = makeEnvWithInsertHandler();
    const req = makeRequest({ address: '+14155551234' });
    const res = await handleWhatsAppSubscribe(req, env as any);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.registered).toBe(false);
  });
});

describe('handleWhatsAppUnsubscribe', () => {
  beforeEach(() => {
    (evaluateGovernanceExecution as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
      decisionId: 'gexec_test',
      governanceMode: 'off',
      actionType: 'channel.whatsapp.unsubscribe',
      actorTenantId: 'default',
      targetTenantId: 'default',
      tenantScope: 'default',
      allowed: true,
      enforcementOutcome: 'bypassed',
      reason: 'bypass_mode_off',
      policyVersion: null,
      signedDecisionToken: null,
      violation: false,
    });
  });

  it('returns 200 with channel=whatsapp', async () => {
    const env = makeEnvWithInsertHandler();
    const req = makeDeleteRequest({ contactId: 'c1', address: '+14155551234' });
    const res = await handleWhatsAppUnsubscribe(req, env as any);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.channel).toBe('whatsapp');
  });

  it('returns 400 when governance blocks unsubscribe', async () => {
    const env = makeEnvWithInsertHandler();
    (evaluateGovernanceExecution as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
      decisionId: 'gexec_block',
      governanceMode: 'enforce',
      actionType: 'channel.whatsapp.unsubscribe',
      actorTenantId: 'default',
      targetTenantId: 'default',
      tenantScope: 'default',
      allowed: false,
      enforcementOutcome: 'blocked',
      reason: 'denied_by_service',
      policyVersion: 'v1',
      signedDecisionToken: null,
      violation: true,
    });
    const req = makeDeleteRequest({ contactId: 'c1', address: '+14155551234' });
    const res = await handleWhatsAppUnsubscribe(req, env as any);
    expect(res.status).toBe(400);
  });
});

// ── SMS ───────────────────────────────────────────────────────────────────────

describe('handleSmsSubscribe', () => {
  it('rejects non-E.164 phone', async () => {
    const env = makeEnvWithInsertHandler();
    const req = makeRequest({ address: '(415) 555-1234' });
    const res = await handleSmsSubscribe(req, env as any);
    expect(res.status).toBe(400);
  });

  it('accepts valid E.164 number', async () => {
    const env = makeEnvWithInsertHandler();
    const req = makeRequest({ address: '+447700900123', contactId: 'c2' });
    const res = await handleSmsSubscribe(req, env as any);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.channel).toBe('sms');
  });
});

describe('handleSmsUnsubscribe', () => {
  it('returns 200', async () => {
    const env = makeEnvWithInsertHandler();
    const req = makeDeleteRequest({ contactId: 'c2', address: '+447700900123' });
    const res = await handleSmsUnsubscribe(req, env as any);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.channel).toBe('sms');
  });
});

// ── Telegram ──────────────────────────────────────────────────────────────────

describe('handleTelegramSubscribe', () => {
  it('rejects non-numeric chat_id', async () => {
    const env = makeEnvWithInsertHandler();
    const req = makeRequest({ address: '@mybot_handle', contactId: 'c3' });
    const res = await handleTelegramSubscribe(req, env as any);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('chat_id');
  });

  it('accepts numeric chat_id', async () => {
    const env = makeEnvWithInsertHandler();
    const req = makeRequest({ address: '123456789', contactId: 'c3' });
    const res = await handleTelegramSubscribe(req, env as any);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.channel).toBe('telegram');
  });

  it('accepts negative chat_id (group/channel chats)', async () => {
    const env = makeEnvWithInsertHandler();
    const req = makeRequest({ address: '-1001234567890', contactId: 'c3' });
    const res = await handleTelegramSubscribe(req, env as any);
    expect(res.status).toBe(201);
  });

  it('returns 400 on invalid JSON body', async () => {
    const env = makeEnvWithInsertHandler();
    const req = new Request('https://example.com/api/channels/telegram/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    const res = await handleTelegramSubscribe(req, env as any);
    expect(res.status).toBe(400);
  });
});

describe('handleTelegramUnsubscribe', () => {
  it('returns 200 with channel=telegram', async () => {
    const env = makeEnvWithInsertHandler();
    const req = makeDeleteRequest({ contactId: 'c3', address: '123456789' });
    const res = await handleTelegramUnsubscribe(req, env as any);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.channel).toBe('telegram');
  });
});

// ── DB insert verification ────────────────────────────────────────────────────

describe('channel subscribe DB insert', () => {
  it('inserts a push_opt_in_events row on SMS subscribe', async () => {
    const env = makeEnvWithInsertHandler();
    const req = makeRequest({ address: '+14155551234', contactId: 'c4', tenantId: 'acme' });
    await handleSmsSubscribe(req, env as any);
    const insertQuery = (env.DB as MockD1Database)._queries.find((q) =>
      q.sql.includes('push_opt_in_events'),
    );
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.params).toContain('acme');
    expect(insertQuery!.params).toContain('sms.subscribed');
  });

  it('inserts revocation row on WhatsApp unsubscribe', async () => {
    const env = makeEnvWithInsertHandler();
    const req = makeDeleteRequest({ contactId: 'c5', address: '+14155559999' });
    await handleWhatsAppUnsubscribe(req, env as any);
    const insertQuery = (env.DB as MockD1Database)._queries.find((q) =>
      q.sql.includes('push_opt_in_events'),
    );
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.params).toContain('whatsapp.unsubscribed');
  });
});
