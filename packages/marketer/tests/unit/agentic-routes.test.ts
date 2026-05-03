import { describe, expect, it } from 'vitest';
import { handleAgenticRoute } from '../../src/routes/agentic';
import { createMockEnv, makeRequest } from '../helpers';

describe('agentic routes', () => {
  it('enforces operation-level scopes', async () => {
    const env = createMockEnv({ AGENT_TOKEN: 'agent-secret', AGENT_TOKEN_SCOPES: 'signals:read' });
    const request = makeRequest('POST', '/api/agentic/actions/propose', {
      subjectId: 'lead@acme.com',
      proposedAction: { type: 'wait' },
    }, { 'x-agent-token': 'agent-secret' });

    const response = await handleAgenticRoute(request, env as any);
    expect(response.status).toBe(403);
  });

  it('lists active growth signals for scoped agents', async () => {
    const env = createMockEnv({ AGENT_TOKEN: 'agent-secret', AGENT_TOKEN_SCOPES: 'signals:read' });
    env.DB.onQuery(/FROM growth_signals/i, () => [{
      id: 1,
      signal_id: 'sig_1',
      tenant_id: 'default',
      subject_type: 'contact',
      subject_id: 'lead@acme.com',
      signal_type: 'trial_expiring_high_intent',
      severity: 'high',
      confidence: 80,
      detected_at: 1,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      source_event_id: null,
      evidence_json: '{"reason":"unit"}',
      status: 'active',
      created_at: 1,
      updated_at: 1,
    }]);

    const request = makeRequest('GET', '/api/agentic/growth-signals', undefined, { 'x-agent-token': 'agent-secret' });
    const response = await handleAgenticRoute(request, env as any);
    const body = await response.json() as { data: { signals: Array<{ signal_id: string; evidence: Record<string, unknown> }> } };

    expect(response.status).toBe(200);
    expect(body.data.signals[0].signal_id).toBe('sig_1');
    expect(body.data.signals[0].evidence.reason).toBe('unit');
  });

  it('returns a structured execution trace for an action', async () => {
    const env = createMockEnv({ AGENT_TOKEN: 'agent-secret', AGENT_TOKEN_SCOPES: 'actions:read' });
    env.DB.onQuery(/SELECT \* FROM agent_actions WHERE action_id = \? LIMIT 1/i, () => [{
      id: 1,
      action_id: 'act_trace_1',
      idempotency_key: 'idem_trace_1',
      correlation_id: 'corr_1',
      agent_id: 'test-agent',
      tenant_id: 'default',
      subject_id: 'lead@acme.com',
      signal_id: 'sig_1',
      proposed_action: 'send_via_skrip',
      proposed_action_json: '{"type":"send_via_skrip"}',
      status: 'executed',
      risk_level: 'medium',
      confidence: 81,
      evidence_json: '{}',
      input_hash: 'in',
      output_hash: 'out',
      policy_result_json: '{"allowed":true,"blockedReasons":[],"warnings":[],"requiredApproval":false,"effectiveChannels":["push"],"cooldownUntil":null,"evidence":{}}',
      ai_metadata_json: '{"fallback":false}',
      created_at: 10,
      updated_at: 11,
      approved_at: 10,
      executed_at: 11,
      outcome_due_at: 12,
      outcome_json: null,
    }]);
    env.DB.onQuery(/SELECT \* FROM agent_action_events WHERE action_id = \?/i, () => [{
      id: 1,
      action_id: 'act_trace_1',
      event_type: 'execution_intent_built',
      actor: 'agentic-api',
      correlation_id: 'corr_1',
      payload_json: '{"intent":{"actionType":"send_via_skrip"}}',
      created_at: 11,
    }]);
    env.DB.onQuery(/FROM channel_execution_outbox o[\s\S]+WHERE json_extract\(o\.payload_json, '\$\.context\.agentActionId'\) = \?/i, () => [{
      id: 1,
      campaign_id: 'agent-growth',
      step_id: 'step-1',
      contact_id: 'lead@acme.com',
      channel: 'push',
      status: 'pending',
      idempotency_key: 'idem_skrip_1',
      payload_json: '{"context":{"agentActionId":"act_trace_1"}}',
      message_id: null,
      skrip_outbound_id: null,
      provider_ref: null,
      latest_status: null,
      last_outcome_at: null,
      created_at: 11,
      updated_at: 11,
    }]);
    env.DB.onQuery(/SELECT \* FROM agent_action_outcomes WHERE action_id = \?/i, () => []);

    const request = makeRequest('GET', '/api/agentic/actions/act_trace_1/trace', undefined, { 'x-agent-token': 'agent-secret' });
    const response = await handleAgenticRoute(request, env as any);
    const body = await response.json() as { data: { trace: { action: { action_id: string }; intent: { actionType: string }; outbox: Array<{ channel: string }> } } };

    expect(response.status).toBe(200);
    expect(body.data.trace.action.action_id).toBe('act_trace_1');
    expect(body.data.trace.intent.actionType).toBe('send_via_skrip');
    expect(body.data.trace.outbox[0].channel).toBe('push');
  });
});