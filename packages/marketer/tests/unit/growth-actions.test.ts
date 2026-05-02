import { describe, expect, it } from 'vitest';
import { AGENT_ACTION_TYPE } from '../../src/constants';
import { executeAgentAction } from '../../src/lib/growth/actions';
import { createMockEnv } from '../helpers';

function waitActionRow() {
  return {
    id: 1,
    action_id: 'act_wait_1',
    idempotency_key: 'idem_wait_1',
    correlation_id: 'corr_1',
    agent_id: 'test-agent',
    tenant_id: 'default',
    subject_id: 'lead@acme.com',
    signal_id: 'sig_1',
    proposed_action: AGENT_ACTION_TYPE.WAIT,
    proposed_action_json: JSON.stringify({ type: AGENT_ACTION_TYPE.WAIT, params: { reviewAfterSeconds: 3600 } }),
    status: 'approved',
    risk_level: 'low',
    confidence: 80,
    evidence_json: '{}',
    input_hash: 'in',
    output_hash: 'out',
    policy_result_json: JSON.stringify({ allowed: true, blockedReasons: [], warnings: [], requiredApproval: false, effectiveChannels: ['ledger'], cooldownUntil: null, evidence: {} }),
    ai_metadata_json: null,
    created_at: 1,
    updated_at: 1,
    approved_at: 1,
    executed_at: null,
    outcome_due_at: 1,
    outcome_json: null,
  };
}

describe('agent action execution', () => {
  it('executes a low-risk wait action through the ledger', async () => {
    const env = createMockEnv();
    env.DB.onQuery(/SELECT \* FROM agent_actions WHERE action_id/i, () => [waitActionRow()]);
    env.DB.onQuery(/SELECT created_at\s+FROM agent_actions/i, () => []);
    env.DB.onQuery(/SELECT COUNT\(\*\) AS count/i, () => [{ count: 0 }]);

    const result = await executeAgentAction(env as any, 'act_wait_1');

    expect(result.executed).toBe(true);
    expect(result.result.type).toBe(AGENT_ACTION_TYPE.WAIT);
    const executedUpdate = env.DB._queries.find((query) =>
      /UPDATE agent_actions/i.test(query.sql) && query.params.includes('executed'),
    );
    expect(executedUpdate).toBeDefined();
  });
});