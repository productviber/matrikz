import type { Env, ProposedAgentAction } from '../../types';
import {
  AGENT_ACTION_TYPE,
  AGENT_RISK_LEVEL,
  EVENT_TYPES,
  GROWTH_POLICY,
  GROWTH_SIGNAL_SEVERITY,
  GROWTH_SIGNAL_TYPE,
} from '../../constants';
import { createAgentActionProposal, type AgentActionView } from './actions';
import { evaluateGrowthPolicy } from './policy';
import type { GrowthSignalView } from './signals';

export interface ProposeEligibleAgentActionsOptions {
  sourceEvent?: string;
  timestamp?: string;
}

function signalEvidence(signal: GrowthSignalView): Record<string, unknown> {
  return signal.evidence;
}

function stepId(signalType: string): string {
  return `agent-${signalType.replace(/_/g, '-')}`.slice(0, 80);
}

function actionForSignal(signal: GrowthSignalView): ProposedAgentAction | null {
  const evidence = signalEvidence(signal);
  const domain = typeof evidence.domain === 'string' ? evidence.domain : undefined;

  switch (signal.signal_type) {
    case GROWTH_SIGNAL_TYPE.SIGNUP_NO_SITE_CONNECTED:
    case GROWTH_SIGNAL_TYPE.INSTALLED_NO_FIRST_ANALYSIS:
    case GROWTH_SIGNAL_TYPE.FIRST_ANALYSIS_NO_RETURN:
    case GROWTH_SIGNAL_TYPE.TRIAL_EXPIRING_HIGH_INTENT:
    case GROWTH_SIGNAL_TYPE.WARM_AUDIT_LEAD_FOLLOWUP:
      return {
        type: AGENT_ACTION_TYPE.ENROLL_SEQUENCE,
        params: {
          triggerEvent: `agentic.${signal.signal_type}`,
          context: { signalId: signal.signal_id, signalType: signal.signal_type },
        },
        reason: `Lifecycle gap detected: ${signal.signal_type}`,
      };

    case GROWTH_SIGNAL_TYPE.COLD_CLICKED_NO_REPLY:
    case GROWTH_SIGNAL_TYPE.AUDIT_GRADE_LOW_HIGH_FIT:
      return {
        type: AGENT_ACTION_TYPE.SEND_VIA_SKRIP,
        params: {
          campaignId: 'agent-led-growth',
          stepId: stepId(signal.signal_type),
          ...(domain ? { domain } : {}),
          context: { signalId: signal.signal_id, signalType: signal.signal_type },
        },
        reason: `High-intent channel follow-up candidate: ${signal.signal_type}`,
      };

    case GROWTH_SIGNAL_TYPE.UNINSTALL_WITH_RECENT_ENGAGEMENT:
      return {
        type: AGENT_ACTION_TYPE.ESCALATE_TO_HUMAN,
        params: { context: { signalId: signal.signal_id, signalType: signal.signal_type } },
        reason: 'Recent engagement followed by uninstall needs operator review.',
      };

    case GROWTH_SIGNAL_TYPE.AUDIT_COMPLETED_NO_SIGNUP:
    case GROWTH_SIGNAL_TYPE.PRICING_VISIT_NO_SIGNUP:
    case GROWTH_SIGNAL_TYPE.SHARE_CREATED_NO_CONVERSION:
    case GROWTH_SIGNAL_TYPE.AFFILIATE_CLICK_NO_SIGNUP:
      return {
        type: AGENT_ACTION_TYPE.MANUAL_REVIEW,
        params: { context: { signalId: signal.signal_id, signalType: signal.signal_type } },
        reason: `Conversion intent detected: ${signal.signal_type}`,
      };

    default:
      return null;
  }
}

function riskForSignal(signal: GrowthSignalView): string {
  if (signal.signal_type === GROWTH_SIGNAL_TYPE.UNINSTALL_WITH_RECENT_ENGAGEMENT) return AGENT_RISK_LEVEL.HIGH;
  if (signal.severity === GROWTH_SIGNAL_SEVERITY.HIGH || signal.severity === GROWTH_SIGNAL_SEVERITY.CRITICAL) {
    return signal.signal_type === GROWTH_SIGNAL_TYPE.COLD_CLICKED_NO_REPLY ? AGENT_RISK_LEVEL.MEDIUM : AGENT_RISK_LEVEL.HIGH;
  }
  return AGENT_RISK_LEVEL.LOW;
}

export async function proposeEligibleAgentActionsFromSignals(
  env: Env,
  signals: GrowthSignalView[],
  options: ProposeEligibleAgentActionsOptions = {},
): Promise<AgentActionView[]> {
  const created: AgentActionView[] = [];

  for (const signal of signals) {
    const proposedAction = actionForSignal(signal);
    if (!proposedAction) continue;

    const riskLevel = riskForSignal(signal);
    const policyResult = await evaluateGrowthPolicy(env, {
      tenantId: signal.tenant_id,
      subjectId: signal.subject_id,
      action: proposedAction,
      riskLevel,
      confidence: signal.confidence,
    });

    created.push(await createAgentActionProposal(env, {
      tenantId: signal.tenant_id,
      subjectId: signal.subject_id,
      signalId: signal.signal_id,
      action: proposedAction,
      riskLevel,
      confidence: signal.confidence,
      evidence: {
        ...signalEvidence(signal),
        signalType: signal.signal_type,
        signalSeverity: signal.severity,
        sourceEvent: options.sourceEvent,
      },
      requestSnapshot: {
        sourceEvent: options.sourceEvent,
        timestamp: options.timestamp,
        signalId: signal.signal_id,
        signalType: signal.signal_type,
      },
      aiMetadata: {
        mode: 'deterministic_event_materializer',
        capabilityVersion: GROWTH_POLICY.DEFAULT_AGENT_ID,
        eventType: options.sourceEvent ?? EVENT_TYPES.AUDIT_COMPLETED,
      },
      policyResult,
    }));
  }

  return created;
}