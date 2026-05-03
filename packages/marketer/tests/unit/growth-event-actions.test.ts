import { describe, expect, it } from 'vitest';
import { AGENT_ACTION_TYPE, GROWTH_SIGNAL_TYPE } from '../../src/constants';
import {
  deterministicFallbackActionForSignal,
  proposeEligibleAgentActionsFromSignals,
} from '../../src/lib/growth/event-actions';
import type { GrowthSignalView } from '../../src/lib/growth/signals';
import { createMockEnv, createMockFetcher } from '../helpers';

function signalRow(overrides: Partial<GrowthSignalView> = {}): GrowthSignalView {
  return {
    id: 1,
    signal_id: 'sig_price_1',
    tenant_id: 'default',
    subject_type: 'affiliate',
    subject_id: 'aff_123',
    signal_type: GROWTH_SIGNAL_TYPE.PRICING_VISIT_NO_SIGNUP,
    severity: 'medium',
    confidence: 70,
    detected_at: 1,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    source_event_id: 'evt_1',
    evidence: { landingPage: '/pricing' },
    status: 'active',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function actionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    action_id: 'act_price_1',
    idempotency_key: 'idem_price_1',
    correlation_id: 'corr_1',
    agent_id: 'visibility-growth-agent',
    tenant_id: 'default',
    subject_id: 'aff_123',
    signal_id: 'sig_price_1',
    proposed_action: AGENT_ACTION_TYPE.WAIT,
    proposed_action_json: JSON.stringify({ type: AGENT_ACTION_TYPE.WAIT, params: { reviewAfterSeconds: 86400, subjectId: 'aff_123' } }),
    status: 'approved',
    risk_level: 'low',
    confidence: 55,
    evidence_json: '{}',
    input_hash: 'input_hash',
    output_hash: 'output_hash',
    policy_result_json: JSON.stringify({ allowed: true, blockedReasons: [], warnings: [], requiredApproval: false, effectiveChannels: ['ledger'], cooldownUntil: null, evidence: {} }),
    ai_metadata_json: JSON.stringify({ fallback: true, provider: null, model: null }),
    created_at: 1,
    updated_at: 1,
    approved_at: 1,
    executed_at: null,
    outcome_due_at: 1,
    outcome_json: null,
    ...overrides,
  };
}

/** Standard set of DB handlers for the no-AI-engine path */
function registerBaseHandlers(env: ReturnType<typeof createMockEnv>, overrides: {
  actionRowOverride?: Record<string, unknown>;
} = {}) {
  // Subject context: recent actions (LEFT JOIN outcomes)
  env.DB.onQuery(/LEFT JOIN agent_action_outcomes/i, () => []);
  // Subject context: active signals
  env.DB.onQuery(/FROM growth_signals/i, () => []);
  // Subject context: marketing_contacts lifecycle stage
  env.DB.onQuery(/FROM marketing_contacts/i, () => []);
  // Subject context: push identity
  env.DB.onQuery(/FROM contact_channel_identities/i, () => []);
  // Policy: frequency cap
  env.DB.onQuery(/SELECT created_at\s+FROM agent_actions/i, () => []);
  // Policy: daily count
  env.DB.onQuery(/SELECT COUNT\(\*\) AS count/i, () => [{ count: 0 }]);
  // createAgentActionProposal: load after upsert
  env.DB.onQuery(/SELECT \* FROM agent_actions WHERE idempotency_key/i, () => [
    actionRow(overrides.actionRowOverride ?? {}),
  ]);
}

describe('growth event action materializer', () => {
  it('uses fallback path when AI_ENGINE is not bound, producing safe wait for medium-severity signal', async () => {
    const env = createMockEnv();
    registerBaseHandlers(env);

    const created = await proposeEligibleAgentActionsFromSignals(env as any, [signalRow()], {
      sourceEvent: 'affiliate.click',
      timestamp: '2026-05-02T12:00:00.000Z',
    });

    expect(created).toHaveLength(1);
    // fallbackGrowthNextAction returns WAIT for medium-severity when AI engine absent
    expect(created[0].proposed_action).toBe(AGENT_ACTION_TYPE.WAIT);
    const insert = env.DB._queries.find((q) => q.sql.includes('INSERT INTO agent_actions'));
    expect(insert).toBeDefined();
    expect(insert?.params).toContain(AGENT_ACTION_TYPE.WAIT);
    expect(env.DB._queries.some((q) => q.sql.includes('INSERT INTO agent_action_events'))).toBe(true);
  });

  it('stores ai_metadata with fallback=true when AI_ENGINE binding is absent', async () => {
    const env = createMockEnv();
    registerBaseHandlers(env);

    await proposeEligibleAgentActionsFromSignals(env as any, [signalRow()], {});

    const insert = env.DB._queries.find((q) => q.sql.includes('INSERT INTO agent_actions'));
    const aiMetadataParam = insert?.params.find(
      (p): p is string => typeof p === 'string' && p.includes('"fallback":true'),
    );
    expect(aiMetadataParam).toBeDefined();
  });

  it('groups multiple signals for the same subject into one proposal', async () => {
    const env = createMockEnv();
    registerBaseHandlers(env);

    const signals = [
      signalRow({ signal_id: 'sig_a', signal_type: GROWTH_SIGNAL_TYPE.PRICING_VISIT_NO_SIGNUP }),
      signalRow({ signal_id: 'sig_b', signal_type: GROWTH_SIGNAL_TYPE.SHARE_CREATED_NO_CONVERSION }),
    ];

    const created = await proposeEligibleAgentActionsFromSignals(env as any, signals, {});
    // Both signals belong to 'aff_123' — expect a single compound proposal
    expect(created).toHaveLength(1);
  });

  it('produces separate proposals for different subjects', async () => {
    const env = createMockEnv();
    // Need two idempotency-key lookup returns for two subjects
    let callCount = 0;
    env.DB.onQuery(/LEFT JOIN agent_action_outcomes/i, () => []);
    env.DB.onQuery(/FROM growth_signals/i, () => []);
    env.DB.onQuery(/FROM marketing_contacts/i, () => []);
    env.DB.onQuery(/FROM contact_channel_identities/i, () => []);
    env.DB.onQuery(/SELECT created_at\s+FROM agent_actions/i, () => []);
    env.DB.onQuery(/SELECT COUNT\(\*\) AS count/i, () => [{ count: 0 }]);
    env.DB.onQuery(/SELECT \* FROM agent_actions WHERE idempotency_key/i, () => {
      callCount++;
      return [actionRow({ action_id: `act_${callCount}`, idempotency_key: `idem_${callCount}` })];
    });

    const signals = [
      signalRow({ subject_id: 'sub_a@acme.com' }),
      signalRow({ subject_id: 'sub_b@acme.com' }),
    ];

    const created = await proposeEligibleAgentActionsFromSignals(env as any, signals, {});
    expect(created).toHaveLength(2);
  });

  it('enriches proposed action context with signal evidence fields', async () => {
    const env = createMockEnv();
    registerBaseHandlers(env);

    const signals = [
      signalRow({
        signal_type: GROWTH_SIGNAL_TYPE.AUDIT_GRADE_LOW_HIGH_FIT,
        severity: 'high',
        evidence: { domain: 'acme.com', auditGrade: 'D', auditScore: 42, companyName: 'Acme Corp' },
      }),
    ];

    await proposeEligibleAgentActionsFromSignals(env as any, signals, {});

    const insert = env.DB._queries.find((q) => q.sql.includes('INSERT INTO agent_actions'));
    // Evidence JSON (index 12 in the INSERT param list) should contain domain
    const evidenceParam = insert?.params.find(
      (p): p is string => typeof p === 'string' && p.includes('acme.com'),
    );
    expect(evidenceParam).toBeDefined();
  });

  it('returns empty array when no signals provided', async () => {
    const env = createMockEnv();
    const created = await proposeEligibleAgentActionsFromSignals(env as any, [], {});
    expect(created).toHaveLength(0);
    expect(env.DB._queries).toHaveLength(0);
  });

  it('uses AI engine response when AI_ENGINE binding is configured', async () => {
    const aiResponse = {
      action: {
        type: AGENT_ACTION_TYPE.ENROLL_SEQUENCE,
        params: {
          triggerEvent: 'agentic.pricing_visit_no_signup',
          interventionMode: 'primary',
          primaryChannel: 'email',
          context: { signalId: 'sig_price_1', signalType: 'pricing_visit_no_signup' },
        },
        reason: 'AI: pricing intent detected, sequence enrollment recommended.',
      },
      riskLevel: 'low',
      confidence: 78,
      explanation: 'Visitor viewed pricing with no signup — warm sequence is appropriate.',
      metadata: {
        provider: 'openai',
        model: 'gpt-4o',
        capability: 'growth-next-action',
        promptVersion: '2026-05-02',
        responseSchemaVersion: 'growth-action-v1',
        latencyMs: 310,
        tokenEstimate: 140,
        costEstimate: 0.0008,
        fallback: false,
      },
      rawSummary: { signalCount: 1 },
    };

    const env = createMockEnv({
      AI_ENGINE: createMockFetcher({
        '/internal/growth-next-action': { body: aiResponse },
      }) as any,
    });

    // For ENROLL_SEQUENCE the subject must be an email
    const emailSignal = signalRow({ subject_id: 'prospect@acme.com' });
    const aiActionRow = actionRow({
      proposed_action: AGENT_ACTION_TYPE.ENROLL_SEQUENCE,
      proposed_action_json: JSON.stringify(aiResponse.action),
      confidence: 78,
      ai_metadata_json: JSON.stringify({ ...aiResponse.metadata, explanation: aiResponse.explanation, fallback: false }),
    });

    env.DB.onQuery(/LEFT JOIN agent_action_outcomes/i, () => []);
    env.DB.onQuery(/FROM growth_signals/i, () => []);
    env.DB.onQuery(/FROM marketing_contacts/i, () => []);
    env.DB.onQuery(/FROM contact_channel_identities/i, () => []);
    env.DB.onQuery(/SELECT created_at\s+FROM agent_actions/i, () => []);
    env.DB.onQuery(/SELECT COUNT\(\*\) AS count/i, () => [{ count: 0 }]);
    env.DB.onQuery(/FROM suppression_list/i, () => []);
    env.DB.onQuery(/SELECT \* FROM agent_actions WHERE idempotency_key/i, () => [aiActionRow]);

    const created = await proposeEligibleAgentActionsFromSignals(env as any, [emailSignal], {
      sourceEvent: 'affiliate.click',
    });

    expect(created).toHaveLength(1);
    expect(created[0].proposed_action).toBe(AGENT_ACTION_TYPE.ENROLL_SEQUENCE);
    const insert = env.DB._queries.find((q) => q.sql.includes('INSERT INTO agent_actions'));
    expect(insert?.params).toContain(AGENT_ACTION_TYPE.ENROLL_SEQUENCE);
    // ai_metadata_json should have fallback: false
    const aiMetaParam = insert?.params.find(
      (p): p is string => typeof p === 'string' && p.includes('"fallback":false'),
    );
    expect(aiMetaParam).toBeDefined();
  });
});

describe('deterministicFallbackActionForSignal', () => {
  it('returns enroll_sequence for lifecycle gap signals', () => {
    const signal = signalRow({ signal_type: GROWTH_SIGNAL_TYPE.TRIAL_EXPIRING_HIGH_INTENT });
    const action = deterministicFallbackActionForSignal(signal);
    expect(action?.type).toBe(AGENT_ACTION_TYPE.ENROLL_SEQUENCE);
  });

  it('returns send_via_skrip for high-intent channel signals', () => {
    const signal = signalRow({
      signal_type: GROWTH_SIGNAL_TYPE.COLD_CLICKED_NO_REPLY,
      evidence: { domain: 'acme.com', auditGrade: 'C' },
    });
    const action = deterministicFallbackActionForSignal(signal);
    expect(action?.type).toBe(AGENT_ACTION_TYPE.SEND_VIA_SKRIP);
    expect((action?.params?.context as any)?.domain).toBe('acme.com');
    expect((action?.params?.context as any)?.auditGrade).toBe('C');
  });

  it('returns escalate_to_human for uninstall with recent engagement', () => {
    const signal = signalRow({ signal_type: GROWTH_SIGNAL_TYPE.UNINSTALL_WITH_RECENT_ENGAGEMENT });
    const action = deterministicFallbackActionForSignal(signal);
    expect(action?.type).toBe(AGENT_ACTION_TYPE.ESCALATE_TO_HUMAN);
  });

  it('returns manual_review for conversion intent signals', () => {
    const signal = signalRow({ signal_type: GROWTH_SIGNAL_TYPE.AFFILIATE_CLICK_NO_SIGNUP });
    const action = deterministicFallbackActionForSignal(signal);
    expect(action?.type).toBe(AGENT_ACTION_TYPE.MANUAL_REVIEW);
  });

  it('returns null for unknown signal types', () => {
    const signal = signalRow({ signal_type: 'unknown_signal_type_xyz' });
    const action = deterministicFallbackActionForSignal(signal);
    expect(action).toBeNull();
  });

  it('includes enriched evidence in context blob', () => {
    const signal = signalRow({
      signal_type: GROWTH_SIGNAL_TYPE.AUDIT_GRADE_LOW_HIGH_FIT,
      evidence: { domain: 'test.com', auditGrade: 'F', auditScore: 12, companyName: 'TestCo', funnelPosition: 'top' },
    });
    const action = deterministicFallbackActionForSignal(signal);
    const context = action?.params?.context as Record<string, unknown>;
    expect(context.domain).toBe('test.com');
    expect(context.auditGrade).toBe('F');
    expect(context.auditScore).toBe(12);
    expect(context.companyName).toBe('TestCo');
    expect(context.funnelPosition).toBe('top');
    expect(context.signalId).toBe('sig_price_1');
    expect(context.signalSeverity).toBe('medium');
  });
});