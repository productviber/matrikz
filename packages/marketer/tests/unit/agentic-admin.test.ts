import { describe, expect, it } from 'vitest';
import {
  handleAdminAgenticPerformance,
  handleAdminAgenticSignals,
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
});