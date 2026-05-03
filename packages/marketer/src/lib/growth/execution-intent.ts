import type {
  Env,
  GrowthExecutionIntent,
  GrowthMessageBrief,
  GrowthMessageBriefResult,
  GrowthSkripStrategicRequest,
} from '../../types';
import { AGENT_ACTION_TYPE, AGENT_RISK_LEVEL } from '../../constants';
import { createAiEngineClient } from '../ai-engine/client';
import { getCorrelationId } from '../correlation';
import { isRecord } from './common';
import type { AgentActionView } from './actions';

function actionParamRecord(action: AgentActionView['proposedAction']): Record<string, unknown> {
  return isRecord(action.params) ? action.params : {};
}

function actionParamString(action: AgentActionView['proposedAction'], key: string): string | null {
  const value = actionParamRecord(action)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function channelHintsForAction(action: AgentActionView): string[] {
  const hints = new Set<string>();
  for (const channel of action.policyResult.effectiveChannels ?? []) {
    if (typeof channel === 'string' && channel.trim()) hints.add(channel.trim());
  }
  const primaryChannel = actionParamString(action.proposedAction, 'primaryChannel');
  if (primaryChannel) hints.add(primaryChannel);
  return Array.from(hints);
}

function executionTargetForAction(actionType: string): GrowthExecutionIntent['executionTarget'] {
  switch (actionType) {
    case AGENT_ACTION_TYPE.SEND_VIA_SKRIP:
      return 'skrip';
    case AGENT_ACTION_TYPE.ENROLL_SEQUENCE:
      return 'sequence';
    case AGENT_ACTION_TYPE.MANUAL_REVIEW:
    case AGENT_ACTION_TYPE.ESCALATE_TO_HUMAN:
      return 'manual_review';
    case AGENT_ACTION_TYPE.START_CAMPAIGN:
    case AGENT_ACTION_TYPE.PAUSE_CAMPAIGN:
    case AGENT_ACTION_TYPE.PAUSE_CONTACT:
      return 'campaign_control';
    default:
      return 'wait';
  }
}

function objectiveForAction(action: AgentActionView): string {
  return actionParamString(action.proposedAction, 'objective')
    ?? actionParamString(action.proposedAction, 'triggerEvent')
    ?? (action.proposed_action === AGENT_ACTION_TYPE.SEND_VIA_SKRIP ? 'strategic_outreach' : action.proposed_action);
}

function urgencyForAction(action: AgentActionView): string {
  if (action.risk_level === AGENT_RISK_LEVEL.CRITICAL || action.risk_level === AGENT_RISK_LEVEL.HIGH) return 'high';
  if (action.risk_level === AGENT_RISK_LEVEL.MEDIUM) return 'medium';
  return 'low';
}

function localeForAction(action: AgentActionView): string {
  const params = actionParamRecord(action.proposedAction);
  const context = isRecord(params.context) ? params.context : {};
  const locale = typeof context.outputLocale === 'string'
    ? context.outputLocale
    : typeof context.locale === 'string'
      ? context.locale
      : null;
  return locale?.trim() || 'en';
}

function normalizeBrief(
  action: AgentActionView,
  intent: GrowthExecutionIntent,
  candidate: Record<string, unknown>,
): GrowthMessageBrief {
  const envelopeData = isRecord(candidate.data) ? candidate.data : candidate;
  const channel = typeof envelopeData.channel === 'string' && envelopeData.channel.trim()
    ? envelopeData.channel.trim()
    : intent.channelHints[0] ?? 'push';
  return {
    objective: typeof envelopeData.objective === 'string' && envelopeData.objective.trim()
      ? envelopeData.objective.trim()
      : objectiveForAction(action),
    channel,
    locale: typeof envelopeData.locale === 'string' && envelopeData.locale.trim()
      ? envelopeData.locale.trim()
      : localeForAction(action),
    headline: typeof envelopeData.headline === 'string' && envelopeData.headline.trim()
      ? envelopeData.headline.trim()
      : `Follow up on ${objectiveForAction(action).replace(/[_-]+/g, ' ')}`,
    bodyIntent: typeof envelopeData.bodyIntent === 'string' && envelopeData.bodyIntent.trim()
      ? envelopeData.bodyIntent.trim()
      : action.proposedAction.reason ?? 'Provide a relevant, concise follow-up message.',
    cta: typeof envelopeData.cta === 'string' && envelopeData.cta.trim()
      ? envelopeData.cta.trim()
      : 'Continue the conversation',
    tone: typeof envelopeData.tone === 'string' && envelopeData.tone.trim()
      ? envelopeData.tone.trim()
      : 'helpful',
    personalizationHints: Array.isArray(envelopeData.personalizationHints)
      ? envelopeData.personalizationHints.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [],
    offerContext: isRecord(envelopeData.offerContext) ? envelopeData.offerContext : {},
    fallbackTemplateKey: typeof envelopeData.fallbackTemplateKey === 'string' && envelopeData.fallbackTemplateKey.trim()
      ? envelopeData.fallbackTemplateKey.trim()
      : null,
  };
}

export function buildGrowthExecutionIntent(action: AgentActionView): GrowthExecutionIntent {
  const metadata = isRecord(action.aiMetadata) ? action.aiMetadata : {};
  return {
    tenantId: action.tenant_id,
    subjectId: action.subject_id,
    actionId: action.action_id,
    actionType: action.proposed_action,
    actionReason: action.proposedAction.reason ?? null,
    riskLevel: action.risk_level,
    confidence: action.confidence,
    strategySource: metadata.fallback === true ? 'fallback' : 'growth-agent',
    growthCapability: typeof metadata.capability === 'string' ? metadata.capability : 'growth-next-action',
    promptVersion: typeof metadata.promptVersion === 'string' ? metadata.promptVersion : null,
    responseSchemaVersion: typeof metadata.responseSchemaVersion === 'string' ? metadata.responseSchemaVersion : null,
    correlationId: getCorrelationId(),
    requestId: action.idempotency_key,
    channelHints: channelHintsForAction(action),
    messageBriefRequired: action.proposed_action === AGENT_ACTION_TYPE.SEND_VIA_SKRIP,
    executionTarget: executionTargetForAction(action.proposed_action),
    policyFlags: {
      allowed: action.policyResult.allowed,
      requiredApproval: action.policyResult.requiredApproval,
      warnings: action.policyResult.warnings ?? [],
      blockedReasons: action.policyResult.blockedReasons ?? [],
      effectiveChannels: action.policyResult.effectiveChannels ?? [],
      cooldownUntil: action.policyResult.cooldownUntil,
    },
    createdAt: action.created_at,
  };
}

export function buildDeterministicMessageBrief(
  action: AgentActionView,
  intent: GrowthExecutionIntent,
): GrowthMessageBrief {
  return {
    objective: objectiveForAction(action),
    channel: intent.channelHints[0] ?? 'push',
    locale: localeForAction(action),
    headline: `Follow up on ${objectiveForAction(action).replace(/[_-]+/g, ' ')}`,
    bodyIntent: action.proposedAction.reason ?? 'Deliver a relevant, policy-safe follow-up.',
    cta: 'Review the latest update',
    tone: 'helpful',
    personalizationHints: [],
    offerContext: {},
    fallbackTemplateKey: action.proposed_action === AGENT_ACTION_TYPE.SEND_VIA_SKRIP ? 'agentic-skrip-followup' : null,
  };
}

export async function resolveGrowthMessageBrief(
  env: Env,
  action: AgentActionView,
  intent: GrowthExecutionIntent,
): Promise<GrowthMessageBriefResult> {
  const fallbackBrief = buildDeterministicMessageBrief(action, intent);
  if (!intent.messageBriefRequired) {
    return {
      brief: fallbackBrief,
      source: 'deterministic',
      degradedReason: 'message_brief_not_required',
      metadata: null,
    };
  }

  const aiClient = createAiEngineClient(env);
  if (!aiClient.configured) {
    return {
      brief: fallbackBrief,
      source: 'deterministic',
      degradedReason: 'message_brief_binding_unavailable',
      metadata: null,
    };
  }

  try {
    const response = await aiClient.messageBrief({
      tenantId: action.tenant_id,
      subjectId: action.subject_id,
      objective: objectiveForAction(action),
      channelHints: intent.channelHints,
      riskLevel: action.risk_level,
      evidence: action.evidence,
      policy: intent.policyFlags,
      agentActionId: action.action_id,
      reason: action.proposedAction.reason ?? null,
    });

    if (!response.ok || !response.data || !isRecord(response.data)) {
      return {
        brief: fallbackBrief,
        source: 'deterministic',
        degradedReason: response.error ?? 'message_brief_unavailable',
        metadata: null,
      };
    }

    const metadata = isRecord(response.data.metadata) ? response.data.metadata : null;
    return {
      brief: normalizeBrief(action, intent, response.data),
      source: 'ai',
      degradedReason: null,
      metadata,
    };
  } catch (error) {
    return {
      brief: fallbackBrief,
      source: 'deterministic',
      degradedReason: error instanceof Error ? error.message : String(error),
      metadata: null,
    };
  }
}

export function buildSkripStrategicRequest(
  action: AgentActionView,
  intent: GrowthExecutionIntent,
  briefResult: GrowthMessageBriefResult,
): GrowthSkripStrategicRequest {
  const channelPreferences = intent.channelHints.length > 0 ? intent.channelHints : ['push'];
  return {
    tenantId: action.tenant_id,
    subjectId: action.subject_id,
    contactIdentityId: action.subject_id,
    objective: briefResult.brief.objective,
    urgency: urgencyForAction(action),
    reason: action.proposedAction.reason ?? 'Agent-directed strategic outreach.',
    channelPreferences,
    constraints: {
      locale: briefResult.brief.locale,
      allowedChannels: intent.policyFlags.effectiveChannels,
      complianceTags: [],
      quietHoursOnly: Boolean(intent.policyFlags.cooldownUntil),
    },
    brief: briefResult.brief,
    lineage: {
      correlationId: intent.correlationId,
      requestId: intent.requestId,
      agentActionId: action.action_id,
      growthCapability: intent.growthCapability,
      promptVersion: intent.promptVersion,
      responseSchemaVersion: intent.responseSchemaVersion,
      strategyVersion: 'growth-execution-intent.v1',
    },
    execution: {
      dryRun: false,
      idempotencyKey: action.idempotency_key,
      priority: urgencyForAction(action) === 'high' ? 'high' : 'normal',
    },
  };
}