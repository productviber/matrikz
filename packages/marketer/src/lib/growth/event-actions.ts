import type { Env, ProposedAgentAction } from '../../types';
import {
  AGENT_ACTION_TYPE,
  AGENT_RISK_LEVEL,
  GROWTH_POLICY,
  GROWTH_SIGNAL_SEVERITY,
  GROWTH_SIGNAL_TYPE,
  SKRIP_POLICY,
} from '../../constants';
import { createAgentActionProposal, type AgentActionView } from './actions';
import { evaluateGrowthPolicy } from './policy';
import type { GrowthSignalView } from './signals';
import {
  createAiEngineClient,
  fallbackGrowthNextAction,
  type GrowthNextActionRequest,
} from '../ai-engine/client';
import { loadSubjectContextForDecision, type SubjectDecisionContext } from './context';

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

/**
 * Extracts a rich context blob from a signal's evidence for use in AI
 * requests, Skrip payload context, and action proposals. Avoids losing
 * domain/grade/funnel data that was present at signal write time.
 */
function buildEnrichedSignalContext(signal: GrowthSignalView): Record<string, unknown> {
  const evidence = signalEvidence(signal);
  return {
    signalId: signal.signal_id,
    signalType: signal.signal_type,
    signalSeverity: signal.severity,
    confidence: signal.confidence,
    ...(typeof evidence.domain === 'string' ? { domain: evidence.domain } : {}),
    ...(typeof evidence.auditGrade === 'string' ? { auditGrade: evidence.auditGrade } : {}),
    ...(typeof evidence.auditScore === 'number' ? { auditScore: evidence.auditScore } : {}),
    ...(typeof evidence.companyName === 'string' ? { companyName: evidence.companyName } : {}),
    ...(typeof evidence.funnelPosition === 'string' ? { funnelPosition: evidence.funnelPosition } : {}),
    ...(typeof evidence.lastActivityAt === 'number' ? { lastActivityAt: evidence.lastActivityAt } : {}),
    ...(typeof evidence.landingPage === 'string' ? { landingPage: evidence.landingPage } : {}),
  };
}

/**
 * Deterministic fallback: maps a single signal to a safe ProposedAgentAction.
 *
 * This function is the fail-closed safety path used when the AI engine is
 * unavailable (not bound, circuit open, or request error). It must never be
 * removed. The context blob is now enriched with all available evidence so
 * that downstream execution layers (Skrip, sequence enrollment) receive the
 * same richness regardless of whether the AI or this fallback produced the
 * action.
 */
export function deterministicFallbackActionForSignal(signal: GrowthSignalView): ProposedAgentAction | null {
  const context = buildEnrichedSignalContext(signal);
  const domain = typeof context.domain === 'string' ? context.domain : undefined;

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
          interventionMode: 'primary',
          primaryChannel: 'email',
          context,
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
          interventionMode: 'rescue',
          primaryChannel: 'email',
          ...(domain ? { domain } : {}),
          context,
        },
        reason: `High-intent channel follow-up candidate: ${signal.signal_type}`,
      };

    case GROWTH_SIGNAL_TYPE.UNINSTALL_WITH_RECENT_ENGAGEMENT:
      return {
        type: AGENT_ACTION_TYPE.ESCALATE_TO_HUMAN,
        params: { context },
        reason: 'Recent engagement followed by uninstall needs operator review.',
      };

    case GROWTH_SIGNAL_TYPE.AUDIT_COMPLETED_NO_SIGNUP:
    case GROWTH_SIGNAL_TYPE.PRICING_VISIT_NO_SIGNUP:
    case GROWTH_SIGNAL_TYPE.SHARE_CREATED_NO_CONVERSION:
    case GROWTH_SIGNAL_TYPE.AFFILIATE_CLICK_NO_SIGNUP:
      return {
        type: AGENT_ACTION_TYPE.MANUAL_REVIEW,
        params: { context },
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

/**
 * Returns the highest-severity risk level across a set of signals for the
 * same subject. Used when the AI engine reasons over compound signal sets.
 */
function dominantRiskForSignals(signals: GrowthSignalView[]): string {
  const ranks: Record<string, number> = {
    [AGENT_RISK_LEVEL.CRITICAL]: 4,
    [AGENT_RISK_LEVEL.HIGH]: 3,
    [AGENT_RISK_LEVEL.MEDIUM]: 2,
    [AGENT_RISK_LEVEL.LOW]: 1,
  };
  let max: string = AGENT_RISK_LEVEL.LOW;
  for (const signal of signals) {
    const risk = riskForSignal(signal);
    if ((ranks[risk] ?? 0) > (ranks[max] ?? 0)) max = risk;
  }
  return max;
}

function normalizeRequestedSkripPolicy(value: unknown): string {
  if (typeof value !== 'string') return SKRIP_POLICY.EMAIL_ONLY;
  const normalized = value.trim().toLowerCase();
  return Object.values(SKRIP_POLICY).includes(normalized as (typeof SKRIP_POLICY)[keyof typeof SKRIP_POLICY])
    ? normalized
    : SKRIP_POLICY.EMAIL_ONLY;
}

function clampSkripPolicyForChannels(action: ProposedAgentAction, effectiveChannels: string[]): ProposedAgentAction {
  if (action.type !== AGENT_ACTION_TYPE.ENROLL_SEQUENCE) return action;

  const requestedPolicy = normalizeRequestedSkripPolicy(action.params?.skripPolicy);
  const hasPush = effectiveChannels.includes('push');
  const hasAdditionalSkripChannel = effectiveChannels.some((channel) => channel !== 'email');

  let skripPolicy: string = SKRIP_POLICY.EMAIL_ONLY;
  if (requestedPolicy === SKRIP_POLICY.PUSH_ASSIST && hasPush) {
    skripPolicy = SKRIP_POLICY.PUSH_ASSIST;
  } else if (requestedPolicy === SKRIP_POLICY.PUSH_PRIMARY_WITH_EMAIL_FALLBACK && hasPush) {
    skripPolicy = SKRIP_POLICY.PUSH_PRIMARY_WITH_EMAIL_FALLBACK;
  } else if (requestedPolicy === SKRIP_POLICY.MULTI_CHANNEL_PROGRESSIVE && hasAdditionalSkripChannel) {
    skripPolicy = SKRIP_POLICY.MULTI_CHANNEL_PROGRESSIVE;
  }

  return {
    ...action,
    params: {
      ...(action.params ?? {}),
      skripPolicy,
    },
  };
}

function buildDiversityPolicyHints(subjectContext: SubjectDecisionContext): Record<string, unknown> {
  const avoidActionTypes = subjectContext.repeatedActionWarnings
    .filter((warning) => warning.noOutcomeCount >= GROWTH_POLICY.DIVERSITY_NO_OUTCOME_THRESHOLD)
    .map((warning) => warning.actionType);
  return {
    diversityRisk: subjectContext.diversityRisk,
    actionTypeDistribution: subjectContext.actionTypeDistribution,
    repeatedActionWarnings: subjectContext.repeatedActionWarnings,
    avoidActionTypes,
    diversityBudget: {
      recentActionLimit: GROWTH_POLICY.DIVERSITY_RECENT_ACTION_LIMIT,
      repeatActionThreshold: GROWTH_POLICY.DIVERSITY_REPEAT_ACTION_THRESHOLD,
      noOutcomeThreshold: GROWTH_POLICY.DIVERSITY_NO_OUTCOME_THRESHOLD,
    },
  };
}

/**
 * Proposes eligible agent actions from a set of growth signals.
 *
 * Decision path (in order of precedence):
 *   1. Signals are grouped by subject so the AI receives the full compound
 *      picture for a subject, not one signal at a time.
 *   2. Subject context (history, active signals, channel state) is loaded
 *      and passed to the AI request.
 *   3. Policy hints are pre-computed from the deterministic fallback action
 *      and forwarded as constraints in the AI request.
 *   4. The AI engine (growthNextAction) is called as the primary decision
 *      path when the AI_ENGINE binding is present and the circuit is closed.
 *   5. If the AI engine is unavailable, fallbackGrowthNextAction() is used.
 *      This is the fail-closed path — it must not be removed.
 *   6. The AI-proposed action is evaluated through the policy engine.
 *      The policy result gates execution regardless of how the action was
 *      proposed.
 */
export async function proposeEligibleAgentActionsFromSignals(
  env: Env,
  signals: GrowthSignalView[],
  options: ProposeEligibleAgentActionsOptions = {},
): Promise<AgentActionView[]> {
  if (signals.length === 0) return [];

  const created: AgentActionView[] = [];
  const aiClient = createAiEngineClient(env);

  // ── Group signals by subject so each subject gets one compound AI call ──
  const bySubject = new Map<string, GrowthSignalView[]>();
  for (const signal of signals) {
    const key = `${signal.tenant_id ?? 'default'}::${signal.subject_id}`;
    const bucket = bySubject.get(key) ?? [];
    bucket.push(signal);
    bySubject.set(key, bucket);
  }

  for (const subjectSignals of bySubject.values()) {
    const primarySignal = subjectSignals[0];
    const tenantId = primarySignal.tenant_id;
    const subjectId = primarySignal.subject_id;
    const riskLevel = dominantRiskForSignals(subjectSignals);
    const dominantConfidence = Math.max(...subjectSignals.map((s) => s.confidence));

    // ── Load subject context for AI reasoning (parallel DB reads) ──
    const subjectContext = await loadSubjectContextForDecision(env, tenantId, subjectId);

    // ── Pre-compute policy hints before the AI call ──
    // Use the deterministic fallback for the primary signal to get a channel
    // eligibility snapshot. This prevents the AI proposing actions that policy
    // will always block. If the hint action itself is null, skip hints.
    let policyHints: Record<string, unknown> = buildDiversityPolicyHints(subjectContext);
    const hintAction = deterministicFallbackActionForSignal(primarySignal);
    if (hintAction) {
      const hintPolicy = await evaluateGrowthPolicy(env, {
        tenantId,
        subjectId,
        action: hintAction,
        riskLevel,
        confidence: dominantConfidence,
      });
      policyHints = {
        ...policyHints,
        effectiveChannels: hintPolicy.effectiveChannels,
        cooldownUntil: hintPolicy.cooldownUntil,
        warnings: hintPolicy.warnings,
        requiredApproval: hintPolicy.requiredApproval,
        // Even if the hint policy blocks, the AI may propose a different action
        // type that passes. We do not short-circuit here.
        hintBlocked: !hintPolicy.allowed,
        hintBlockedReasons: hintPolicy.blockedReasons,
      };
    }

    // ── Build AI engine request ──
    const aiRequest: GrowthNextActionRequest = {
      tenantId,
      subjectId,
      signals: subjectSignals.map((s) => ({
        signalId: s.signal_id,
        signalType: s.signal_type,
        severity: s.severity,
        confidence: s.confidence,
        evidence: buildEnrichedSignalContext(s),
        detectedAt: s.detected_at,
        expiresAt: s.expires_at,
      })),
      context: {
        ...(options.sourceEvent ? { sourceEvent: options.sourceEvent } : {}),
        ...(options.timestamp ? { timestamp: options.timestamp } : {}),
        subjectContext,
        policyHints,
      },
    };

    // ── Call AI engine or fall back to deterministic ──
    const aiResult = aiClient.configured
      ? await aiClient.growthNextAction(aiRequest)
      : fallbackGrowthNextAction(aiRequest, 'AI_ENGINE binding not configured');

    // ── Evaluate policy against the AI-proposed action ──
    const initialPolicyResult = await evaluateGrowthPolicy(env, {
      tenantId,
      subjectId,
      action: aiResult.action,
      riskLevel: aiResult.riskLevel ?? riskLevel,
      confidence: aiResult.confidence,
    });

    const normalizedAction = clampSkripPolicyForChannels(aiResult.action, initialPolicyResult.effectiveChannels ?? []);
    const policyResult = normalizedAction === aiResult.action
      ? initialPolicyResult
      : await evaluateGrowthPolicy(env, {
        tenantId,
        subjectId,
        action: normalizedAction,
        riskLevel: aiResult.riskLevel ?? riskLevel,
        confidence: aiResult.confidence,
      });

    // ── Combine evidence from all signals for this subject ──
    const combinedEvidence: Record<string, unknown> = {
      signalCount: subjectSignals.length,
      signalTypes: subjectSignals.map((s) => s.signal_type),
      dominantSeverity: riskLevel,
      sourceEvent: options.sourceEvent,
      subjectContext: {
        lastActionType: subjectContext.lastActionType,
        lastActionDaysAgo: subjectContext.lastActionDaysAgo,
        recentOutcomeTypes: subjectContext.recentOutcomes.map((o) => o.outcomeType),
        actionTypeDistribution: subjectContext.actionTypeDistribution,
        repeatedActionWarnings: subjectContext.repeatedActionWarnings,
        diversityRisk: subjectContext.diversityRisk,
        activeSignalCount: subjectContext.activeSignalCount,
        pushRegistered: subjectContext.pushRegistered,
        activeChannels: subjectContext.activeChannels,
        lifecycleStage: subjectContext.lifecycleStage,
      },
    };
    // Merge primary signal evidence (domain, grade, etc.) without overwriting
    for (const [k, v] of Object.entries(signalEvidence(primarySignal))) {
      if (!(k in combinedEvidence)) combinedEvidence[k] = v;
    }

    created.push(await createAgentActionProposal(env, {
      tenantId,
      subjectId,
      signalId: primarySignal.signal_id,
      action: normalizedAction,
      riskLevel: aiResult.riskLevel ?? riskLevel,
      confidence: aiResult.confidence,
      evidence: combinedEvidence,
      requestSnapshot: {
        sourceEvent: options.sourceEvent,
        timestamp: options.timestamp,
        signalId: primarySignal.signal_id,
        signalTypes: subjectSignals.map((s) => s.signal_type),
        aiRequestSummary: {
          signalCount: subjectSignals.length,
          subjectContextLoaded: true,
          policyHintsComputed: Boolean(hintAction) || subjectContext.actionTypeDistribution.length > 0,
        },
      },
      aiMetadata: {
        ...aiResult.metadata,
        explanation: aiResult.explanation,
        fallback: aiResult.metadata.fallback,
        rawSummary: aiResult.rawSummary,
      },
      policyResult,
    }));
  }

  return created;
}