import { describe, expect, it } from 'vitest';
import { AGENT_ACTION_TYPE, GROWTH_SIGNAL_TYPE } from '../../src/constants';
import { proposeEligibleAgentActionsFromSignals } from '../../src/lib/growth/event-actions';
import type { GrowthSignalView } from '../../src/lib/growth/signals';
import { createMockEnv } from '../helpers';

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

function actionRow() {
  return {
    id: 1,
    action_id: 'act_price_1',
    idempotency_key: 'idem_price_1',
    correlation_id: 'corr_1',
    agent_id: 'visibility-growth-agent',
    tenant_id: 'default',
    subject_id: 'aff_123',
    signal_id: 'sig_price_1',
    proposed_action: AGENT_ACTION_TYPE.MANUAL_REVIEW,
    proposed_action_json: JSON.stringify({ type: AGENT_ACTION_TYPE.MANUAL_REVIEW, params: { context: { signalId: 'sig_price_1' } } }),
    status: 'approved',
    risk_level: 'low',
    confidence: 70,
    evidence_json: '{}',
    input_hash: 'input_hash',
    output_hash: 'output_hash',
    policy_result_json: JSON.stringify({ allowed: true, blockedReasons: [], warnings: [], requiredApproval: false, effectiveChannels: ['operator'], cooldownUntil: null, evidence: {} }),
    ai_metadata_json: null,
    created_at: 1,
    updated_at: 1,
    approved_at: 1,
    executed_at: null,
    outcome_due_at: 1,
    outcome_json: null,
  };
}

describe('growth event action materializer', () => {
  it('creates deterministic agent action proposals from eligible signals', async () => {
    const env = createMockEnv();
    env.DB.onQuery(/SELECT created_at\s+FROM agent_actions/i, () => []);
    env.DB.onQuery(/SELECT COUNT\(\*\) AS count/i, () => [{ count: 0 }]);
    env.DB.onQuery(/SELECT \* FROM agent_actions WHERE idempotency_key/i, () => [actionRow()]);

    const created = await proposeEligibleAgentActionsFromSignals(env as any, [signalRow()], {
      sourceEvent: 'affiliate.click',
      timestamp: '2026-05-02T12:00:00.000Z',
    });

    expect(created).toHaveLength(1);
    expect(created[0].proposed_action).toBe(AGENT_ACTION_TYPE.MANUAL_REVIEW);
    const insert = env.DB._queries.find((query) => query.sql.includes('INSERT INTO agent_actions'));
    expect(insert).toBeDefined();
    expect(insert?.params).toContain(AGENT_ACTION_TYPE.MANUAL_REVIEW);
    expect(env.DB._queries.some((query) => query.sql.includes('INSERT INTO agent_action_events'))).toBe(true);
  });
});