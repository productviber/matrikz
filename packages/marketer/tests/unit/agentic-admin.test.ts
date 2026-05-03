import { describe, expect, it } from 'vitest';
import {
  handleAgentDecisionTrace,
  handleAdminAgenticQuality,
  handleAdminAgenticPerformance,
  handleAdminAgenticSignals,
  handleAttributeAgentActionOutcomes,
  handleOverrideAgentAction,
  handleApproveAgentAction,
  handleMarkStaleAgentActions,
} from '../../src/routes/admin/agentic';
import { createMockEnv, makeRequest } from '../helpers';

describe('agentic admin operator endpoints', () => {
  it('lists signals with lifecycle counts for operators', async () => {
    const env = createMockEnv();
    env.DB.onQuery(/SELECT \*\s+FROM growth_signals/i, () => [
      {
        id: 1,
        signal_id: 'sig_1',
        tenant_id: 'default',
        subject_type: 'contact',
        subject_id: 'lead@acme.com',
        signal_type: 'cold_clicked_no_reply',
        severity: 'high',
        confidence: 84,
        detected_at: 1,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        source_event_id: null,
        evidence_json: '{"source":"unit"}',
        status: 'active',
        created_at: 1,
        updated_at: 1,
      },
    ]);
    env.DB.onQuery(/SELECT status, COUNT\(\*\) AS count\s+FROM growth_signals/i, () => [
      { status: 'active', count: 2 },
      { status: 'converted', count: 1 },
    ]);

    const response = await handleAdminAgenticSignals(
      makeRequest('GET', '/api/admin/agentic/signals?tenantId=default'),
      env as any,
    );
    const body = await response.json() as { data: any };

    expect(response.status).toBe(200);
    expect(body.data.signals[0].signal_id).toBe('sig_1');
    expect(body.data.lifecycle[0].status).toBe('active');
  });

  it('returns performance rollups and action correlations', async () => {
    const env = createMockEnv();
    env.DB.onQuery(/GROUP BY status/i, () => [{ status: 'executed', count: 3 }]);
    env.DB.onQuery(/GROUP BY proposed_action/i, () => [{ proposed_action: 'send_via_skrip', count: 2 }]);
    env.DB.onQuery(/GROUP BY risk_level/i, () => [{ risk_level: 'low', count: 2 }]);
    env.DB.onQuery(/GROUP BY outcome_type/i, () => [{ outcome_type: 'message.delivered', count: 1, value_cents: null }]);
    env.DB.onQuery(/json_extract\(ceo\.payload_json/i, () => [{ action_id: 'act_1', proposed_action: 'send_via_skrip', outbox_rows: 1, dispatched_rows: 1, failed_rows: 0 }]);
    env.DB.onQuery(/LEFT JOIN email_sends/i, () => [{ action_id: 'act_2', subject_id: 'lead@acme.com', email_sends: 1, opened: 1, clicked: 0, replied: 0 }]);
    env.DB.onQuery(/status = \?/i, () => []);

    const response = await handleAdminAgenticPerformance(
      makeRequest('GET', '/api/admin/agentic/performance?windowDays=14'),
      env as any,
    );
    const body = await response.json() as { data: any };

    expect(response.status).toBe(200);
    expect(body.data.statusCounts[0].status).toBe('executed');
    expect(body.data.channelCorrelations[0].action_id).toBe('act_1');
    expect(body.data.emailCorrelations[0].action_id).toBe('act_2');
  });

  it('approves a pending high-risk action with an audit event', async () => {
    const env = createMockEnv();
    env.DB.onQuery(/FROM agent_actions WHERE action_id/i, () => [
      { action_id: 'act_review', status: 'policy_checked', policy_result_json: '{"requiredApproval":true}' },
    ]);

    const response = await handleApproveAgentAction(
      makeRequest('POST', '/api/admin/agentic/actions/act_review/approve', { actor: 'ops@example.com' }),
      env as any,
      'act_review',
    );
    const body = await response.json() as { data: any };

    expect(response.status).toBe(200);
    expect(body.data.status).toBe('approved');
    expect(env.DB._queries.some((query) => query.sql.includes('INSERT INTO agent_action_events'))).toBe(true);
  });

  it('marks stale executed actions as no_outcome_observed', async () => {
    const env = createMockEnv();
    env.DB.onQuery(/FROM agent_actions[\s\S]+NOT EXISTS/i, () => [
      { action_id: 'act_stale', outcome_due_at: 10 },
    ]);

    const response = await handleMarkStaleAgentActions(
      makeRequest('POST', '/api/admin/agentic/outcomes/review-stale?limit=10'),
      env as any,
    );
    const body = await response.json() as { data: any };

    expect(response.status).toBe(200);
    expect(body.data.marked).toBe(1);
    expect(env.DB._queries.some((query) => query.sql.includes('agent_action_outcomes'))).toBe(true);
  });

  it('attributes conversion outcomes from executed actions', async () => {
    const env = createMockEnv();
    env.DB.onQuery(/FROM agent_actions a[\s\S]+outcome_type IN \('conversion', 'engagement'\)/i, () => [
      {
        action_id: 'act_attr_1',
        tenant_id: 'default',
        subject_id: 'lead@acme.com',
        proposed_action: 'enroll_sequence',
        created_at: 100,
        outcome_due_at: 1000,
      },
    ]);
    env.DB.onQuery(/FROM marketing_contacts[\s\S]+converted_at/i, () => [{ converted_at: 200 }]);

    const response = await handleAttributeAgentActionOutcomes(
      makeRequest('POST', '/api/admin/agentic/outcomes/attribute?limit=10'),
      env as any,
    );
    const body = await response.json() as { data: any };

    expect(response.status).toBe(200);
    expect(body.data.attributed).toBe(1);
    expect(body.data.conversionAttributed).toBe(1);
  });

  it('returns decision trace rows for a subject', async () => {
    const env = createMockEnv();
    env.DB.onQuery(/FROM agent_actions a/i, () => [
      {
        action_id: 'act_trace_1',
        signal_id: 'sig_1',
        proposed_action: 'send_via_skrip',
        status: 'executed',
        risk_level: 'medium',
        confidence: 81,
        evidence_json: '{}',
        ai_metadata_json: '{"fallback":false}',
        policy_result_json: '{"allowed":true}',
        outcome_json: null,
        created_at: 10,
        updated_at: 11,
        event_count: 3,
        last_outcome_type: 'engagement',
        last_outcome_at: 12,
      },
    ]);

    const response = await handleAgentDecisionTrace(
      makeRequest('GET', '/api/admin/agentic/subjects/lead%40acme.com/decision-trace?tenantId=default'),
      env as any,
      'lead%40acme.com',
    );
    const body = await response.json() as { data: any };

    expect(response.status).toBe(200);
    expect(body.data.trace[0].action_id).toBe('act_trace_1');
  });

  it('returns quality rollups with fallback and policy block rates', async () => {
    const env = createMockEnv();
    env.DB.onQuery(/COUNT\(\*\) AS count FROM agent_actions WHERE created_at >= \?/i, () => [{ count: 10 }]);
    env.DB.onQuery(/ai_metadata_json IS NOT NULL/i, () => [{ count: 2 }]);
    env.DB.onQuery(/status IN \(\?, \?\)/i, () => [{ count: 6 }]);
    env.DB.onQuery(/status = \?/i, () => [{ count: 1 }]);
    env.DB.onQuery(/ROUND\(AVG\(confidence\), 2\)/i, () => [{ proposed_action: 'enroll_sequence', avg_confidence: 72, proposals: 7 }]);
    env.DB.onQuery(/FROM agent_action_outcomes o[\s\S]+o\.outcome_type = 'conversion'/i, () => [{ proposed_action: 'enroll_sequence', conversions: 3 }]);

    const response = await handleAdminAgenticQuality(
      makeRequest('GET', '/api/admin/agentic/quality?windowDays=14'),
      env as any,
    );
    const body = await response.json() as { data: any };

    expect(response.status).toBe(200);
    expect(body.data.totalProposals).toBe(10);
    expect(body.data.fallbackRate).toBe(0.2);
    expect(body.data.policyBlockRate).toBe(0.1);
  });

  it('overrides a non-executed action and records override audit events', async () => {
    const env = createMockEnv();
    env.DB.onQuery(/SELECT action_id, tenant_id, subject_id, status, risk_level, confidence[\s\S]+WHERE action_id = \?/i, () => [
      {
        action_id: 'act_override_1',
        tenant_id: 'default',
        subject_id: 'lead@acme.com',
        status: 'policy_checked',
        risk_level: 'low',
        confidence: 80,
      },
    ]);

    const response = await handleOverrideAgentAction(
      makeRequest('POST', '/api/admin/agentic/actions/act_override_1/override', {
        actor: 'ops@example.com',
        reason: 'manual correction',
        action: {
          type: 'wait',
          params: { reviewAfterSeconds: 7200 },
        },
      }),
      env as any,
      'act_override_1',
    );
    const body = await response.json() as { data: any };

    expect(response.status).toBe(200);
    expect(body.data.actionId).toBe('act_override_1');
    expect(env.DB._queries.some((query) => /UPDATE agent_actions/i.test(query.sql))).toBe(true);
    expect(env.DB._queries.some((query) => /INSERT INTO agent_action_events/i.test(query.sql))).toBe(true);
  });
});