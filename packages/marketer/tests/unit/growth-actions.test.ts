import { describe, expect, it } from 'vitest';
import { AGENT_ACTION_TYPE } from '../../src/constants';
import { executeAgentAction } from '../../src/lib/growth/actions';
import { createMockEnv, createMockFetcher } from '../helpers';

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

function skripActionRow() {
  return {
    ...waitActionRow(),
    action_id: 'act_skrip_1',
    idempotency_key: 'idem_skrip_1',
    proposed_action: AGENT_ACTION_TYPE.SEND_VIA_SKRIP,
    proposed_action_json: JSON.stringify({
      type: AGENT_ACTION_TYPE.SEND_VIA_SKRIP,
      params: {
        campaignId: 'agent-growth',
        stepId: 'step-1',
        primaryChannel: 'push',
        objective: 're_engagement',
        interventionMode: 'rescue',
        context: { locale: 'en', companyName: 'Acme', signalType: 'trial_expiring_high_intent' },
      },
      reason: 'Reach the contact via the best available channel.',
    }),
    evidence_json: JSON.stringify({ signalType: 'trial_expiring_high_intent', domain: 'acme.com' }),
    policy_result_json: JSON.stringify({
      allowed: true,
      blockedReasons: [],
      warnings: [],
      requiredApproval: false,
      effectiveChannels: ['push', 'whatsapp'],
      cooldownUntil: null,
      evidence: {},
    }),
    ai_metadata_json: JSON.stringify({
      capability: 'growth-next-action',
      promptVersion: 'growth-next-action-1.0.0',
      responseSchemaVersion: '1.0.0',
      fallback: false,
    }),
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

  it('builds a structured intent and Skrip handoff for send_via_skrip', async () => {
    const env = createMockEnv({
      SKRIP_DEFAULT_ENABLEMENT: 'true',
      AI_ENGINE: {
        fetch: async () => new Response(JSON.stringify({
          ok: true,
          data: {
            objective: 're_engagement',
            channel: 'push',
            headline: 'Check your latest visibility change',
            bodyIntent: 'Prompt the user to review the newest insight.',
            cta: 'Open dashboard',
            tone: 'direct',
            personalizationHints: ['companyName'],
            offerContext: { companyName: 'Acme' },
            fallbackTemplateKey: 'agentic-skrip-followup',
          },
          metadata: { provider: 'test', model: 'unit' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      } as any,
    });
    env.DB.onQuery(/SELECT \* FROM agent_actions WHERE action_id/i, () => [skripActionRow()]);
    env.DB.onQuery(/SELECT created_at\s+FROM agent_actions/i, () => []);
    env.DB.onQuery(/SELECT COUNT\(\*\) AS count/i, () => [{ count: 0 }]);
    env.DB.onQuery(/FROM contact_channel_identities/i, () => [{
      id: 1,
      tenant_id: 'default',
      external_contact_id: 'lead@acme.com',
      canonical_id: 'skrip_can_1',
      channel: 'push',
      consent_state: 'opted_in',
      suppression_state: 'clear',
      availability_state: 'available',
      identity_confidence: 1,
      registration_state: 'registered',
      last_reconciled_at: null,
      created_at: 1,
      updated_at: 1,
    }]);
    env.DB.onQuery(/FROM channel_authorities/i, () => [{
      id: 1,
      tenant_id: 'default',
      campaign_id: 'agent-growth',
      channel: 'push',
      authority: 'skrip',
      rollout_state: 'dry_run',
      feature_flag_key: null,
      created_at: 1,
      updated_at: 1,
    }]);

    const result = await executeAgentAction(env as any, 'act_skrip_1');

    expect(result.executed).toBe(true);
    const outboxInsert = env.DB._queries.find((query) => /INSERT OR IGNORE INTO channel_execution_outbox/i.test(query.sql));
    expect(outboxInsert).toBeDefined();
    const payload = JSON.parse(String(outboxInsert?.params[8]));
    expect(payload.context.growthExecutionIntent.actionType).toBe(AGENT_ACTION_TYPE.SEND_VIA_SKRIP);
    expect(payload.context.messageBrief.headline).toBe('Check your latest visibility change');
    expect(payload.context.skripStrategicRequest.lineage.agentActionId).toBe('act_skrip_1');

    const eventTypes = env.DB._queries
      .filter((query) => /INSERT INTO agent_action_events/i.test(query.sql))
      .map((query) => String(query.params[1]));
    expect(eventTypes).toContain('execution_intent_built');
    expect(eventTypes).toContain('message_brief_ready');
    expect(eventTypes).toContain('skrip_handoff_prepared');
    expect(eventTypes).toContain('skrip_handoff_enqueued');
  });
});