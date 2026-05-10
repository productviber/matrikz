import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleGovernanceModeOverride,
  handleGovernanceEnforcementStatus,
} from '../../src/routes/admin';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';
import { KV_PREFIX } from '../../src/constants';

describe('handleGovernanceEnforcementStatus()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv({ GOVERNANCE_INGRESS_MODE: 'observe' });
  });

  it('returns env mode when no KV override is set', async () => {
    const req = makeRequest('GET', '/api/admin/governance/enforcement-status');
    const res = await handleGovernanceEnforcementStatus(req, env as any);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    const data = body.data ?? body;
    expect(data.activeMode).toBe('observe');
    expect(data.envMode).toBe('observe');
    expect(data.kvOverride).toBeNull();
    expect(data.overrideActive).toBe(false);
    expect(Array.isArray(data.policy.allowedAuthoritySources)).toBe(true);
    expect(data.policy.allowedAuthoritySources).toContain('visibility-analytics');
  });

  it('returns KV override mode when set and marks overrideActive', async () => {
    await env.KV_MARKETING.put(KV_PREFIX.GOVERNANCE_MODE_OVERRIDE, 'enforce');
    const req = makeRequest('GET', '/api/admin/governance/enforcement-status');
    const res = await handleGovernanceEnforcementStatus(req, env as any);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    const data = body.data ?? body;
    expect(data.activeMode).toBe('enforce');
    expect(data.kvOverride).toBe('enforce');
    expect(data.envMode).toBe('observe');
    expect(data.overrideActive).toBe(true);
  });

  it('returns parsed policy including requireTargetTenantActionTypes', async () => {
    env.GOVERNANCE_REQUIRE_TARGET_TENANT_ACTIONS = 'enroll_sequence,send_via_skrip';
    const req = makeRequest('GET', '/api/admin/governance/enforcement-status');
    const res = await handleGovernanceEnforcementStatus(req, env as any);
    const body = await res.json() as any;
    const data = body.data ?? body;
    expect(data.policy.requireTargetTenantActionTypes).toContain('enroll_sequence');
    expect(data.policy.requireTargetTenantActionTypes).toContain('send_via_skrip');
  });
});

describe('handleGovernanceModeOverride() POST', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv({ GOVERNANCE_INGRESS_MODE: 'off' });
  });

  it('sets the KV override for a valid mode', async () => {
    const req = makeRequest('POST', '/api/admin/governance/mode-override', { mode: 'observe' });
    const res = await handleGovernanceModeOverride(req, env as any);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    const data = body.data ?? body;
    expect(data.overrideSet).toBe(true);
    expect(data.mode).toBe('observe');
    expect(data.expiresInSeconds).toBe(604800);

    const stored = await env.KV_MARKETING.get(KV_PREFIX.GOVERNANCE_MODE_OVERRIDE);
    expect(stored).toBe('observe');
  });

  it('sets enforce mode', async () => {
    const req = makeRequest('POST', '/api/admin/governance/mode-override', { mode: 'enforce' });
    const res = await handleGovernanceModeOverride(req, env as any);
    expect(res.status).toBe(200);
    const stored = await env.KV_MARKETING.get(KV_PREFIX.GOVERNANCE_MODE_OVERRIDE);
    expect(stored).toBe('enforce');
  });

  it('sets off mode (emergency revert)', async () => {
    await env.KV_MARKETING.put(KV_PREFIX.GOVERNANCE_MODE_OVERRIDE, 'enforce');
    const req = makeRequest('POST', '/api/admin/governance/mode-override', { mode: 'off' });
    const res = await handleGovernanceModeOverride(req, env as any);
    expect(res.status).toBe(200);
    const stored = await env.KV_MARKETING.get(KV_PREFIX.GOVERNANCE_MODE_OVERRIDE);
    expect(stored).toBe('off');
  });

  it('rejects invalid mode with 400', async () => {
    const req = makeRequest('POST', '/api/admin/governance/mode-override', { mode: 'strict' });
    const res = await handleGovernanceModeOverride(req, env as any);
    expect(res.status).toBe(400);
  });

  it('rejects missing mode field with 400', async () => {
    const req = makeRequest('POST', '/api/admin/governance/mode-override', { foo: 'bar' });
    const res = await handleGovernanceModeOverride(req, env as any);
    expect(res.status).toBe(400);
  });

  it('rejects non-JSON body with 400', async () => {
    const req = new Request('https://test.workers.dev/api/admin/governance/mode-override', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not-json',
    });
    const res = await handleGovernanceModeOverride(req, env as any);
    expect(res.status).toBe(400);
  });
});

describe('handleGovernanceModeOverride() DELETE', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv({ GOVERNANCE_INGRESS_MODE: 'observe' });
  });

  it('clears the KV override and returns env mode', async () => {
    await env.KV_MARKETING.put(KV_PREFIX.GOVERNANCE_MODE_OVERRIDE, 'enforce');

    const req = new Request('https://test.workers.dev/api/admin/governance/mode-override', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await handleGovernanceModeOverride(req, env as any);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    const data = body.data ?? body;
    expect(data.cleared).toBe(true);
    expect(data.activeMode).toBe('observe');

    const stored = await env.KV_MARKETING.get(KV_PREFIX.GOVERNANCE_MODE_OVERRIDE);
    expect(stored).toBeNull();
  });

  it('succeeds even if no override was set (idempotent)', async () => {
    const req = new Request('https://test.workers.dev/api/admin/governance/mode-override', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await handleGovernanceModeOverride(req, env as any);
    expect(res.status).toBe(200);
  });
});
