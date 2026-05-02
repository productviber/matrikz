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
});