import { describe, it, expect } from 'vitest';
import { evaluateGovernanceIngress } from '../../src/lib/governance-ingress';
import { createMockEnv, makeRequest } from '../helpers';
import type { EventEnvelope } from '../../src/types';

function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event: 'some.future.event',
    source: 'visibility-analytics',
    timestamp: new Date().toISOString(),
    data: { tenantId: 'default', actionType: 'campaign.start' },
    ...overrides,
  };
}

describe('evaluateGovernanceIngress()', () => {
  it('mode=off bypasses authority checks', () => {
    const env = createMockEnv({ GOVERNANCE_INGRESS_MODE: 'off' });
    const decision = evaluateGovernanceIngress(
      makeEnvelope({ authorityContext: { source: 'visibility-analytics', allowed: true } as any }),
      makeRequest('POST', '/events'),
      env as any,
    );

    expect(decision.allowed).toBe(true);
    expect(decision.enforcementOutcome).toBe('bypassed');
    expect(decision.reason).toBe('bypass_mode_off');
  });

  it('mode=observe allows absent authority context and marks observed gap', () => {
    const env = createMockEnv({ GOVERNANCE_INGRESS_MODE: 'observe' });
    const decision = evaluateGovernanceIngress(
      makeEnvelope(),
      makeRequest('POST', '/events'),
      env as any,
    );

    expect(decision.allowed).toBe(true);
    expect(decision.enforcementOutcome).toBe('observed');
    expect(decision.reason).toBe('authority_context_absent');
    expect(decision.violation).toBe(true);
  });

  it('mode=observe allows malformed forwarded context but records violation', () => {
    const env = createMockEnv({ GOVERNANCE_INGRESS_MODE: 'observe' });
    const decision = evaluateGovernanceIngress(
      makeEnvelope({ authorityContext: { source: 'visibility-analytics' } as any }),
      makeRequest('POST', '/events'),
      env as any,
    );

    expect(decision.allowed).toBe(true);
    expect(decision.enforcementOutcome).toBe('observed');
    expect(decision.reason).toBe('authority_context_missing_decision_id');
    expect(decision.violation).toBe(true);
  });

  it('mode=observe allows untrusted authority source but records violation', () => {
    const env = createMockEnv({
      GOVERNANCE_INGRESS_MODE: 'observe',
      GOVERNANCE_ALLOWED_AUTHORITY_SOURCES: 'visibility-analytics',
    });
    const decision = evaluateGovernanceIngress(
      makeEnvelope({
        authorityContext: {
          decisionId: 'dec-source-1',
          source: 'untrusted-forwarder',
          allowed: true,
        },
      }),
      makeRequest('POST', '/events'),
      env as any,
    );

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('authority_context_untrusted_source');
    expect(decision.enforcementOutcome).toBe('observed');
  });

  it('mode=enforce blocks malformed forwarded context', () => {
    const env = createMockEnv({ GOVERNANCE_INGRESS_MODE: 'enforce' });
    const decision = evaluateGovernanceIngress(
      makeEnvelope({ authorityContext: { source: 'visibility-analytics', allowed: true } as any }),
      makeRequest('POST', '/events'),
      env as any,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.enforcementOutcome).toBe('blocked');
    expect(decision.reason).toBe('authority_context_missing_decision_id');
  });

  it('mode=enforce blocks untrusted authority source', () => {
    const env = createMockEnv({
      GOVERNANCE_INGRESS_MODE: 'enforce',
      GOVERNANCE_ALLOWED_AUTHORITY_SOURCES: 'visibility-analytics',
    });
    const decision = evaluateGovernanceIngress(
      makeEnvelope({
        authorityContext: {
          decisionId: 'dec-source-block',
          source: 'evil-forwarder',
          allowed: true,
        },
      }),
      makeRequest('POST', '/events'),
      env as any,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('authority_context_untrusted_source');
    expect(decision.enforcementOutcome).toBe('blocked');
  });

  it('mode=enforce allows valid forwarded context', () => {
    const env = createMockEnv({ GOVERNANCE_INGRESS_MODE: 'enforce' });
    const decision = evaluateGovernanceIngress(
      makeEnvelope({
        authorityContext: {
          decisionId: 'dec-1',
          source: 'visibility-analytics',
          allowed: true,
          actorTenantId: 'default',
          targetTenantId: 'default',
        },
      }),
      makeRequest('POST', '/events'),
      env as any,
    );

    expect(decision.allowed).toBe(true);
    expect(decision.enforcementOutcome).toBe('observed');
    expect(decision.reason).toBe('authority_context_valid');
    expect(decision.violation).toBe(false);
  });

  it('mode=enforce blocks target tenant mismatch', () => {
    const env = createMockEnv({ GOVERNANCE_INGRESS_MODE: 'enforce' });
    const decision = evaluateGovernanceIngress(
      makeEnvelope({
        data: { tenantId: 'tenant-a' },
        authorityContext: {
          decisionId: 'dec-tenant',
          source: 'visibility-analytics',
          allowed: true,
          targetTenantId: 'tenant-b',
        },
      }),
      makeRequest('POST', '/events'),
      env as any,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('authority_context_target_tenant_mismatch');
  });

  it('mode=enforce requires target tenant for sensitive actions', () => {
    const env = createMockEnv({ GOVERNANCE_INGRESS_MODE: 'enforce' });
    const decision = evaluateGovernanceIngress(
      makeEnvelope({
        data: { tenantId: 'default', actionType: 'send_via_skrip' },
        authorityContext: {
          decisionId: 'dec-target-required',
          source: 'visibility-analytics',
          allowed: true,
        },
      }),
      makeRequest('POST', '/events'),
      env as any,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('authority_context_target_tenant_required');
  });

  it('mode=enforce can be restricted to high-risk action list only', () => {
    const env = createMockEnv({
      GOVERNANCE_INGRESS_MODE: 'enforce',
      GOVERNANCE_ENFORCE_ACTIONS: 'send_via_skrip',
    });
    const decision = evaluateGovernanceIngress(
      makeEnvelope({
        data: { tenantId: 'default', actionType: 'campaign.start' },
        authorityContext: {
          source: 'visibility-analytics',
          allowed: true,
        } as any,
      }),
      makeRequest('POST', '/events'),
      env as any,
    );

    expect(decision.allowed).toBe(true);
    expect(decision.enforcementOutcome).toBe('observed');
    expect(decision.reason).toBe('authority_context_missing_decision_id');
  });
});
