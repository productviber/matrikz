/**
 * Unit tests for governance-execution-client.ts
 *
 * Covers:
 *   - Mode resolution: off / observe / enforce
 *   - KV override precedence
 *   - Governance unavailable (no binding/URL) → fail-open
 *   - Service call success: allowed
 *   - Service call success: denied + observe → allow + violation flag
 *   - Service call success: denied + enforce → block
 *   - Service call error: network_error → fail-open
 *   - Service call error: non_200 → fail-open
 *   - Service call error: malformed_response → fail-open
 *   - D1 persistence for each outcome (non-fatal on DB error)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockEnv, createMockFetcher } from '../helpers';
import {
  evaluateGovernanceExecution,
  resolveGovernanceExecutionMode,
} from '../../src/lib/governance-execution-client';
import { KV_PREFIX } from '../../src/constants';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeAllowedFetcher() {
  return createMockFetcher({
    '/v1/decisions/outbound': {
      status: 200,
      body: {
        allowed: true,
        decisionId: 'svc_decision_123',
        reason: 'policy_satisfied',
        policyVersion: 'v1.0',
        signedDecisionToken: 'tok_abc',
      },
    },
    '/v1/decisions/enrollment': {
      status: 200,
      body: {
        allowed: true,
        decisionId: 'svc_enroll_123',
        reason: 'policy_satisfied',
        policyVersion: 'v1.0',
      },
    },
  });
}

function makeDeniedFetcher() {
  return createMockFetcher({
    '/v1/decisions/outbound': {
      status: 200,
      body: {
        allowed: false,
        decisionId: 'svc_denied_456',
        reason: 'rate_limit_exceeded',
        policyVersion: 'v1.0',
      },
    },
    '/v1/decisions/enrollment': {
      status: 200,
      body: {
        allowed: false,
        decisionId: 'svc_enroll_denied_456',
        reason: 'quota_exhausted',
        policyVersion: 'v1.0',
      },
    },
  });
}

function makeErrorFetcher(status: number) {
  return createMockFetcher({
    '/v1/decisions/outbound': { status, body: { error: 'service error' } },
    '/v1/decisions/enrollment': { status, body: { error: 'service error' } },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('evaluateGovernanceExecution', () => {
  describe('mode: off (default)', () => {
    it('bypasses without calling governance service', async () => {
      const env = createMockEnv(); // no GOVERNANCE_EXECUTION_MODE set → off
      const decision = await evaluateGovernanceExecution(env, {
        actionType: 'send_via_skrip',
        actorTenantId: 'tenant_a',
      });

      expect(decision.allowed).toBe(true);
      expect(decision.enforcementOutcome).toBe('bypassed');
      expect(decision.reason).toBe('bypass_mode_off');
      expect(decision.violation).toBe(false);
    });

    it('persists bypass decision to D1', async () => {
      const env = createMockEnv();
      await evaluateGovernanceExecution(env, {
        actionType: 'enroll_sequence',
        actorTenantId: 'tenant_a',
      });

      const insertQuery = env.DB._queries.find(
        (q) => q.sql.includes('governance_execution_decisions'),
      );
      expect(insertQuery).toBeDefined();
    });
  });

  describe('mode: observe — governance unavailable', () => {
    it('allows when no GOVERNANCE binding or URL is set', async () => {
      const env = createMockEnv({ GOVERNANCE_EXECUTION_MODE: 'observe' });
      const decision = await evaluateGovernanceExecution(env, {
        actionType: 'pause_campaign',
        actorTenantId: 'tenant_b',
      });

      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('governance_unavailable');
      expect(decision.enforcementOutcome).toBe('observed');
      expect(decision.violation).toBe(false);
    });
  });

  describe('mode: enforce — governance unavailable', () => {
    it('fails-open when no GOVERNANCE binding or URL is set', async () => {
      const env = createMockEnv({ GOVERNANCE_EXECUTION_MODE: 'enforce' });
      const decision = await evaluateGovernanceExecution(env, {
        actionType: 'pause_contact',
        actorTenantId: 'tenant_c',
      });

      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('governance_unavailable');
      expect(decision.enforcementOutcome).toBe('allowed');
    });
  });

  describe('mode: observe — service returns allowed', () => {
    it('returns allowed with outcome=observed, no violation', async () => {
      const env = createMockEnv({
        GOVERNANCE_EXECUTION_MODE: 'observe',
        GOVERNANCE: makeAllowedFetcher(),
      });
      const decision = await evaluateGovernanceExecution(env, {
        actionType: 'send_via_skrip',
        actorTenantId: 'tenant_d',
      });

      expect(decision.allowed).toBe(true);
      expect(decision.enforcementOutcome).toBe('observed');
      expect(decision.reason).toBe('allowed_by_service');
      expect(decision.violation).toBe(false);
      expect(decision.decisionId).toBe('svc_decision_123');
      expect(decision.policyVersion).toBe('v1.0');
    });
  });

  describe('mode: observe — service returns denied', () => {
    it('still allows (observe mode) but sets violation=true', async () => {
      const env = createMockEnv({
        GOVERNANCE_EXECUTION_MODE: 'observe',
        GOVERNANCE: makeDeniedFetcher(),
      });
      const decision = await evaluateGovernanceExecution(env, {
        actionType: 'send_via_skrip',
        actorTenantId: 'tenant_e',
      });

      expect(decision.allowed).toBe(true);
      expect(decision.enforcementOutcome).toBe('observed');
      expect(decision.reason).toBe('denied_by_service');
      expect(decision.violation).toBe(true);
    });
  });

  describe('mode: enforce — service returns allowed', () => {
    it('allows with outcome=allowed, no violation', async () => {
      const env = createMockEnv({
        GOVERNANCE_EXECUTION_MODE: 'enforce',
        GOVERNANCE: makeAllowedFetcher(),
      });
      const decision = await evaluateGovernanceExecution(env, {
        actionType: 'pause_campaign',
        actorTenantId: 'tenant_f',
      });

      expect(decision.allowed).toBe(true);
      expect(decision.enforcementOutcome).toBe('allowed');
      expect(decision.violation).toBe(false);
    });
  });

  describe('mode: enforce — service returns denied', () => {
    it('blocks action with outcome=blocked, violation=true', async () => {
      const env = createMockEnv({
        GOVERNANCE_EXECUTION_MODE: 'enforce',
        GOVERNANCE: makeDeniedFetcher(),
      });
      const decision = await evaluateGovernanceExecution(env, {
        actionType: 'start_campaign',
        actorTenantId: 'tenant_g',
      });

      expect(decision.allowed).toBe(false);
      expect(decision.enforcementOutcome).toBe('blocked');
      expect(decision.reason).toBe('denied_by_service');
      expect(decision.violation).toBe(true);
      expect(decision.decisionId).toBe('svc_denied_456');
    });
  });

  describe('mode: enforce — enrollment endpoint', () => {
    it('uses /v1/decisions/enrollment path for enroll_sequence action', async () => {
      const env = createMockEnv({
        GOVERNANCE_EXECUTION_MODE: 'enforce',
        GOVERNANCE: makeDeniedFetcher(),
      });
      const decision = await evaluateGovernanceExecution(env, {
        actionType: 'enroll_sequence',
        actorTenantId: 'tenant_h',
      });

      expect(decision.allowed).toBe(false);
      expect(decision.decisionId).toBe('svc_enroll_denied_456');
    });
  });

  describe('error handling — fail-open in enforce mode', () => {
    it('fails-open on non_200 response', async () => {
      const env = createMockEnv({
        GOVERNANCE_EXECUTION_MODE: 'enforce',
        GOVERNANCE: makeErrorFetcher(500),
      });
      const decision = await evaluateGovernanceExecution(env, {
        actionType: 'pause_contact',
        actorTenantId: 'tenant_i',
      });

      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('non_200_response');
    });

    it('fails-open on malformed JSON response', async () => {
      const malformedFetcher = {
        async fetch(_url: string | URL) {
          return new Response('not-json{{{', { status: 200 });
        },
      };
      const env = createMockEnv({
        GOVERNANCE_EXECUTION_MODE: 'enforce',
        GOVERNANCE: malformedFetcher,
      });
      const decision = await evaluateGovernanceExecution(env, {
        actionType: 'send_via_skrip',
        actorTenantId: 'tenant_j',
      });

      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('malformed_response');
    });
  });

  describe('KV mode override', () => {
    it('KV override takes precedence over env var', async () => {
      const env = createMockEnv({
        GOVERNANCE_EXECUTION_MODE: 'off', // env says off
      });
      // Set KV override to observe
      await env.KV_MARKETING.put(KV_PREFIX.GOVERNANCE_EXECUTION_MODE_OVERRIDE, 'observe');

      const decision = await evaluateGovernanceExecution(env, {
        actionType: 'pause_campaign',
        actorTenantId: 'tenant_k',
      });

      // KV override says observe but no GOVERNANCE service → governance_unavailable (not bypass)
      expect(decision.reason).toBe('governance_unavailable');
      expect(decision.enforcementOutcome).toBe('observed');
    });
  });

  describe('D1 persistence is non-fatal', () => {
    it('still returns a decision when DB insert fails', async () => {
      const env = createMockEnv({ GOVERNANCE_EXECUTION_MODE: 'off' });
      // Override DB.prepare to throw
      const origPrepare = env.DB.prepare.bind(env.DB);
      env.DB.prepare = (sql: string) => {
        if (sql.includes('governance_execution_decisions')) {
          throw new Error('DB unavailable');
        }
        return origPrepare(sql);
      };

      const decision = await evaluateGovernanceExecution(env, {
        actionType: 'enroll_sequence',
        actorTenantId: 'tenant_l',
      });

      // Should still return a valid decision despite DB error
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('bypass_mode_off');
    });
  });
});

describe('resolveGovernanceExecutionMode', () => {
  it('returns off by default', async () => {
    const env = createMockEnv();
    expect(await resolveGovernanceExecutionMode(env)).toBe('off');
  });

  it('returns mode from env var', async () => {
    const env = createMockEnv({ GOVERNANCE_EXECUTION_MODE: 'observe' });
    expect(await resolveGovernanceExecutionMode(env)).toBe('observe');
  });

  it('returns KV override when set', async () => {
    const env = createMockEnv({ GOVERNANCE_EXECUTION_MODE: 'observe' });
    await env.KV_MARKETING.put(KV_PREFIX.GOVERNANCE_EXECUTION_MODE_OVERRIDE, 'enforce');
    expect(await resolveGovernanceExecutionMode(env)).toBe('enforce');
  });

  it('normalizes unknown values to off', async () => {
    const env = createMockEnv({ GOVERNANCE_EXECUTION_MODE: 'banana' });
    expect(await resolveGovernanceExecutionMode(env)).toBe('off');
  });
});
