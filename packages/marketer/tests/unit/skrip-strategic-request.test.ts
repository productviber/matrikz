import { describe, expect, it } from 'vitest';
import { buildGrowthExecutionIntent, buildSkripStrategicRequest } from '../../src/lib/growth/execution-intent';
import type { AgentActionView } from '../../src/lib/growth/actions';
import { AGENT_ACTION_TYPE } from '../../src/constants';

describe('Skrip strategic request generation', () => {
  it('builds a strict strategic request with contract-compliant constraints', () => {
    const action = {
      action_id: 'act_123',
      idempotency_key: 'tenant:subject:signal:none:0:hash',
      correlation_id: 'corr_123',
      agent_id: null,
      tenant_id: 'tenant-1',
      subject_id: 'subject-1',
      signal_id: 'signal-1',
      proposed_action: AGENT_ACTION_TYPE.SEND_VIA_SKRIP,
      proposedAction: {
        type: AGENT_ACTION_TYPE.SEND_VIA_SKRIP,
        params: { campaignId: 'agent-growth', stepId: 'agent-step' },
        reason: 'Follow up on high intent signal',
      },
      proposed_action_json: JSON.stringify({
        type: AGENT_ACTION_TYPE.SEND_VIA_SKRIP,
        params: { campaignId: 'agent-growth', stepId: 'agent-step' },
        reason: 'Follow up on high intent signal',
      }),
      status: 'approved',
      risk_level: 'medium',
      confidence: 75,
      evidence_json: JSON.stringify({ auditScore: 92 }),
      input_hash: 'hash',
      output_hash: 'hash',
      policy_result_json: JSON.stringify({ allowed: true, effectiveChannels: ['email', 'push'], blockedReasons: [] }),
      policyResult: { allowed: true, effectiveChannels: ['email', 'push'], blockedReasons: [] },
      ai_metadata_json: JSON.stringify({ capability: 'growth-next-action', promptVersion: '1.0.0', responseSchemaVersion: '1.0.0' }),
      aiMetadata: { capability: 'growth-next-action', promptVersion: '1.0.0', responseSchemaVersion: '1.0.0' },
      created_at: 1,
      updated_at: 1,
      approved_at: 1,
      executed_at: 1,
      outcome_due_at: 1,
      outcome_json: null,
    } as unknown as AgentActionView;

    const intent = buildGrowthExecutionIntent(action);
    const briefResult = {
      brief: {
        objective: 're-engage the prospect',
        channel: 'email',
        locale: 'en',
        headline: 'We noticed your interest',
        bodyIntent: 'Send a concise re-engagement message',
        cta: 'Continue the conversation',
        tone: 'helpful',
        personalizationHints: ['company'] as string[],
        offerContext: { product: 'Visibility' },
        fallbackTemplateKey: 'agentic-skrip-followup',
      },
      source: 'ai',
      degradedReason: null,
      metadata: { provider: 'workers-ai' },
    } as const;

    const request = buildSkripStrategicRequest(action, intent, briefResult);

    expect(request.tenantId).toBe('tenant-1');
    expect(request.subjectId).toBe('subject-1');
    expect(request.contactIdentityId).toBe('subject-1');
    expect(request.lineage.agentActionId).toBe('act_123');
    expect(request.lineage.correlationId).toBeTruthy();
    expect(request.constraints).toEqual({
      brandVoice: 'professional, concise',
      locale: 'en',
      forbiddenClaims: [],
      complianceTags: [],
    });
    expect(Object.keys(request.constraints)).toEqual([
      'brandVoice',
      'locale',
      'forbiddenClaims',
      'complianceTags',
    ]);
    // email is filtered out — only dispatchable channels (push/whatsapp/telegram/sms) are sent
    expect(request.channelPreferences).toEqual(['push']);
    expect(request.brief.fallbackTemplateKey).toBe('agentic-skrip-followup');
  });

  it('falls back to [push] when all effective channels are email-only (non-dispatchable)', () => {
    const emailOnlyAction = {
      action_id: 'act_email',
      idempotency_key: 'tenant:subject:signal:none:0:email',
      correlation_id: 'corr_email',
      agent_id: null,
      tenant_id: 'tenant-1',
      subject_id: 'subject-1',
      signal_id: 'signal-1',
      proposed_action: AGENT_ACTION_TYPE.SEND_VIA_SKRIP,
      proposedAction: {
        type: AGENT_ACTION_TYPE.SEND_VIA_SKRIP,
        params: {},
        reason: 'Email-only outreach',
      },
      proposed_action_json: '{}',
      status: 'approved',
      risk_level: 'low',
      confidence: 80,
      evidence_json: '{}',
      input_hash: 'h',
      output_hash: 'h',
      policy_result_json: JSON.stringify({ allowed: true, effectiveChannels: ['email'], blockedReasons: [] }),
      policyResult: { allowed: true, effectiveChannels: ['email'], blockedReasons: [] },
      ai_metadata_json: '{}',
      aiMetadata: {},
      created_at: 1,
      updated_at: 1,
      approved_at: 1,
      executed_at: 1,
      outcome_due_at: 1,
      outcome_json: null,
    } as unknown as AgentActionView;

    const emailIntent = buildGrowthExecutionIntent(emailOnlyAction);
    const emailBriefResult = {
      brief: {
        objective: 'email outreach',
        channel: 'email',
        locale: 'en',
        headline: 'Quick check-in',
        bodyIntent: 'Send a short email follow-up',
        cta: 'Reply here',
        tone: 'helpful',
        personalizationHints: [] as string[],
        offerContext: {},
        fallbackTemplateKey: 'agentic-email-followup',
      },
      source: 'deterministic',
      degradedReason: null,
      metadata: null,
    } as const;

    const emailRequest = buildSkripStrategicRequest(emailOnlyAction, emailIntent, emailBriefResult);
    // email is not dispatchable via strategic send; falls back to push
    expect(emailRequest.channelPreferences).toEqual(['push']);
  });
});
