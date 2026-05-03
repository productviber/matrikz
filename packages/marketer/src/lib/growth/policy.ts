import type { Env, GrowthPolicyResult, ProposedAgentAction } from '../../types';
import {
  AGENT_ACTION_TYPE,
  AGENT_RISK_LEVEL,
  GROWTH_POLICY,
  KV_UNSUBSCRIBE_PREFIX,
  PATTERNS,
  SKRIP_POLICY,
  SKRIP_ROLLOUT_STATE,
  isPersonalEmail,
} from '../../constants';
import { now, queryOne } from '../db';
import { isSuppressed } from '../suppression';
import { getEligibleSkripIdentities } from '../skrip/outbox';
import { resolveSkripExecutionDecision } from '../skrip/router';
import { normalizeSubjectId, normalizeTenantId } from './common';

export interface GrowthPolicyInput {
  tenantId?: string | null;
  subjectId: string;
  action: ProposedAgentAction;
  riskLevel?: string;
  confidence?: number;
  actionId?: string | null;
}

const ALLOWED_ACTION_TYPES = new Set<string>(Object.values(AGENT_ACTION_TYPE));
const EXECUTION_ACTIONS = new Set<string>([
  AGENT_ACTION_TYPE.ENROLL_SEQUENCE,
  AGENT_ACTION_TYPE.SEND_VIA_SKRIP,
  AGENT_ACTION_TYPE.PAUSE_CAMPAIGN,
  AGENT_ACTION_TYPE.START_CAMPAIGN,
  AGENT_ACTION_TYPE.PAUSE_CONTACT,
  AGENT_ACTION_TYPE.ESCALATE_TO_HUMAN,
  AGENT_ACTION_TYPE.WAIT,
  AGENT_ACTION_TYPE.MANUAL_REVIEW,
]);

function parseBoolean(input: string | null | undefined): boolean {
  return ['true', '1', 'yes', 'enabled', 'on'].includes((input ?? '').trim().toLowerCase());
}

function isEmail(subjectId: string): boolean {
  return PATTERNS.EMAIL.test(subjectId);
}

function isHighRisk(riskLevel?: string): boolean {
  return riskLevel === AGENT_RISK_LEVEL.HIGH || riskLevel === AGENT_RISK_LEVEL.CRITICAL;
}

function actionParamString(action: ProposedAgentAction, key: string): string | null {
  const value = action.params?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function actionParamContextSignalType(action: ProposedAgentAction): string | null {
  const context = action.params?.context;
  if (!context || typeof context !== 'object') return null;
  const record = context as Record<string, unknown>;
  return typeof record.signalType === 'string' && record.signalType.trim().length > 0
    ? record.signalType.trim()
    : null;
}

function isHighIntentOrUrgencySignal(signalType: string | null): boolean {
  return signalType === 'cold_clicked_no_reply'
    || signalType === 'audit_grade_low_high_fit'
    || signalType === 'trial_expiring_high_intent';
}

function actionParamSkripPolicy(action: ProposedAgentAction): string {
  const policy = actionParamString(action, 'skripPolicy');
  if (!policy) return SKRIP_POLICY.EMAIL_ONLY;
  const normalized = policy.trim().toLowerCase();
  const valid = Object.values(SKRIP_POLICY);
  return valid.includes(normalized as (typeof SKRIP_POLICY)[keyof typeof SKRIP_POLICY])
    ? normalized
    : SKRIP_POLICY.EMAIL_ONLY;
}

function defaultAutonomyThresholdPct(actionType: string): number | null {
  if (actionType === AGENT_ACTION_TYPE.ENROLL_SEQUENCE) return 0;
  if (actionType === AGENT_ACTION_TYPE.SEND_VIA_SKRIP) return 20;
  return null;
}

async function resolveEligibleSkripChannels(
  env: Env,
  tenantId: string,
  subjectId: string,
  campaignId: string,
): Promise<{ channels: string[]; identityCount: number; channelDecisions: Array<Record<string, unknown>>; warnings: string[] }> {
  const warnings: string[] = [];
  const channels: string[] = [];
  const identities = await getEligibleSkripIdentities(env, tenantId, subjectId);
  const channelDecisions: Array<Record<string, unknown>> = [];

  for (const identity of identities) {
    const channelKillSwitch = await env.KV_MARKETING.get(`${GROWTH_POLICY.KILL_SWITCH_CHANNEL_PREFIX}${tenantId}:${identity.channel}`);
    const decision = await resolveSkripExecutionDecision(env, tenantId, campaignId, identity.channel);
    const channelKilled = parseBoolean(channelKillSwitch);
    channelDecisions.push({
      channel: identity.channel,
      killed: channelKilled,
      authority: decision.authority,
      rolloutState: decision.rolloutState,
      enabled: decision.useSkrip || decision.dryRun,
    });
    if (!channelKilled && (decision.useSkrip || decision.dryRun)) {
      channels.push(identity.channel);
    }
    if (decision.rolloutState === SKRIP_ROLLOUT_STATE.DRY_RUN) {
      warnings.push(`skrip_channel_${identity.channel}_dry_run`);
    }
  }

  return {
    channels,
    identityCount: identities.length,
    channelDecisions,
    warnings,
  };
}

export async function evaluateGrowthPolicy(env: Env, input: GrowthPolicyInput): Promise<GrowthPolicyResult> {
  const tenantId = normalizeTenantId(input.tenantId);
  const subjectId = normalizeSubjectId(input.subjectId);
  const actionType = input.action.type;
  const riskLevel = input.riskLevel ?? AGENT_RISK_LEVEL.MEDIUM;
  const blockedReasons: string[] = [];
  const warnings: string[] = [];
  const evidence: Record<string, unknown> = {
    tenantId,
    subjectId,
    actionType,
    riskLevel,
  };
  let requiredApproval = isHighRisk(riskLevel);
  let cooldownUntil: number | null = null;
  let effectiveChannels: string[] = [];
  const interventionMode = (actionParamString(input.action, 'interventionMode') ?? 'primary').toLowerCase();
  const primaryChannel = (actionParamString(input.action, 'primaryChannel') ?? 'email').toLowerCase();
  const skripPolicy = actionParamSkripPolicy(input.action);
  const signalType = actionParamContextSignalType(input.action);

  evidence.intervention = {
    mode: interventionMode,
    primaryChannel,
    skripPolicy,
    signalType,
  };

  if (!ALLOWED_ACTION_TYPES.has(actionType)) {
    blockedReasons.push('unsupported_action_type');
  }
  if (!EXECUTION_ACTIONS.has(actionType)) {
    blockedReasons.push('non_executable_action_type');
  }

  if (parseBoolean(env.AGENT_EXECUTION_DISABLED)) {
    blockedReasons.push('global_agent_execution_disabled');
  }

  const [globalKillSwitch, tenantKillSwitch, autonomyLevelRaw] = await Promise.all([
    env.KV_MARKETING.get(GROWTH_POLICY.KILL_SWITCH_GLOBAL_KEY),
    env.KV_MARKETING.get(`${GROWTH_POLICY.KILL_SWITCH_TENANT_PREFIX}${tenantId}`),
    env.KV_MARKETING.get(`${GROWTH_POLICY.AUTONOMY_LEVEL_PREFIX}${tenantId}`),
  ]);
  // Autonomy level (0–3); absent key defaults to level 1 (supervised).
  const autonomyLevel = autonomyLevelRaw !== null ? parseInt(autonomyLevelRaw, 10) : 1;
  evidence.autonomyLevel = Number.isFinite(autonomyLevel) ? autonomyLevel : 1;
  if (parseBoolean(globalKillSwitch)) blockedReasons.push('global_agent_kill_switch');
  if (parseBoolean(tenantKillSwitch)) blockedReasons.push('tenant_agent_kill_switch');

  const campaignRef = actionParamString(input.action, 'campaignId') ?? actionParamString(input.action, 'campaignSlug');
  if (campaignRef) {
    const campaignKillSwitch = await env.KV_MARKETING.get(`${GROWTH_POLICY.KILL_SWITCH_CAMPAIGN_PREFIX}${tenantId}:${campaignRef}`);
    evidence.campaignKillSwitch = Boolean(parseBoolean(campaignKillSwitch));
    if (parseBoolean(campaignKillSwitch)) blockedReasons.push('campaign_agent_kill_switch');
  }

  if ((input.confidence ?? GROWTH_POLICY.DEFAULT_CONFIDENCE) < GROWTH_POLICY.MIN_EXECUTION_CONFIDENCE) {
    warnings.push('low_confidence_recommendation');
  }

  if (isEmail(subjectId)) {
    const [suppressed, unsubscribed] = await Promise.all([
      isSuppressed(env.DB, subjectId),
      env.KV_MARKETING.get(`${KV_UNSUBSCRIBE_PREFIX}${subjectId}`),
    ]);
    evidence.emailPolicy = {
      suppressed,
      unsubscribed: Boolean(unsubscribed),
      personalEmail: isPersonalEmail(subjectId),
    };
    if (suppressed) blockedReasons.push('suppressed_contact');
    if (unsubscribed) blockedReasons.push('unsubscribed_contact');
    if (isPersonalEmail(subjectId) && (actionType === AGENT_ACTION_TYPE.ENROLL_SEQUENCE || actionType === AGENT_ACTION_TYPE.SEND_VIA_SKRIP)) {
      blockedReasons.push('personal_email_blocked_for_outbound');
    }
  }

  const recentAction = await queryOne<{ created_at: number }>(
    env.DB,
    `SELECT created_at
       FROM agent_actions
      WHERE tenant_id = ?
        AND subject_id = ?
        AND proposed_action = ?
        AND status IN ('approved', 'executed', 'policy_checked')
        AND created_at > ?
        AND action_id <> ?
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenantId, subjectId, actionType, Math.floor(Date.now() / 1000) - GROWTH_POLICY.ACTION_WINDOW_SECONDS, input.actionId ?? ''],
  );
  if (recentAction) {
    cooldownUntil = recentAction.created_at + GROWTH_POLICY.ACTION_WINDOW_SECONDS;
    blockedReasons.push('frequency_cap_active');
  }

  const todayStart = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  const dailyCount = await queryOne<{ count: number }>(
    env.DB,
    `SELECT COUNT(*) AS count
       FROM agent_actions
      WHERE tenant_id = ?
        AND status IN ('approved', 'executed')
        AND created_at > ?`,
    [tenantId, todayStart],
  );
  evidence.dailyActionCount = dailyCount?.count ?? 0;
  if ((dailyCount?.count ?? 0) >= GROWTH_POLICY.DAILY_ACTION_LIMIT) {
    blockedReasons.push('daily_action_budget_exhausted');
  }

  if (actionType === AGENT_ACTION_TYPE.SEND_VIA_SKRIP) {
    // Skrip is a complementary rail in this phase: it must be used as a
    // rescue channel for high-intent or high-urgency moments.
    if (interventionMode !== 'rescue') {
      blockedReasons.push('skrip_send_requires_rescue_mode');
    }
    if (!isHighIntentOrUrgencySignal(signalType)) {
      blockedReasons.push('skrip_send_requires_high_intent_or_urgency_signal');
    }

    const campaignId = campaignRef ?? 'agent-growth';
    const skripChannels = await resolveEligibleSkripChannels(env, tenantId, subjectId, campaignId);
    effectiveChannels = skripChannels.channels;
    warnings.push(...skripChannels.warnings);
    evidence.skripIdentityCount = skripChannels.identityCount;
    evidence.skripChannelDecisions = skripChannels.channelDecisions;
    if (skripChannels.identityCount === 0) blockedReasons.push('no_eligible_skrip_channel');
    if (skripChannels.identityCount > 0 && effectiveChannels.length === 0) blockedReasons.push('no_enabled_skrip_channel_authority');
    if (effectiveChannels.length > 1) requiredApproval = true;
  }

  if (actionType === AGENT_ACTION_TYPE.ENROLL_SEQUENCE && !isEmail(subjectId)) {
    blockedReasons.push('sequence_enrollment_requires_email_subject');
  }

  if (actionType === AGENT_ACTION_TYPE.ENROLL_SEQUENCE && interventionMode === 'rescue') {
    // Reciprocal rescue is allowed: email can rescue a primary push path.
    if (primaryChannel !== 'push') {
      warnings.push('email_rescue_mode_without_push_primary');
    }
  }

  if (actionType === AGENT_ACTION_TYPE.PAUSE_CONTACT && !isEmail(subjectId)) {
    blockedReasons.push('pause_contact_requires_email_subject');
  }

  if (actionType === AGENT_ACTION_TYPE.START_CAMPAIGN || actionType === AGENT_ACTION_TYPE.PAUSE_CAMPAIGN) {
    const campaignRef = actionParamString(input.action, 'campaignId') ?? actionParamString(input.action, 'campaignSlug') ?? subjectId;
    const campaign = await queryOne<{ id: number; slug: string; status: string }>(
      env.DB,
      `SELECT id, slug, status
         FROM outbound_campaigns
        WHERE slug = ? OR CAST(id AS TEXT) = ?
        LIMIT 1`,
      [campaignRef, campaignRef],
    );
    evidence.campaign = campaign ?? null;
    if (!campaign) {
      blockedReasons.push('campaign_not_found');
    } else if (actionType === AGENT_ACTION_TYPE.START_CAMPAIGN && !['draft', 'paused'].includes(campaign.status)) {
      blockedReasons.push('campaign_not_startable');
    } else if (actionType === AGENT_ACTION_TYPE.PAUSE_CAMPAIGN && campaign.status !== 'active') {
      blockedReasons.push('campaign_not_active');
    }
    requiredApproval = true;
  }

  if (actionType === AGENT_ACTION_TYPE.ESCALATE_TO_HUMAN || actionType === AGENT_ACTION_TYPE.MANUAL_REVIEW) {
    effectiveChannels = ['operator'];
  }
  if (actionType === AGENT_ACTION_TYPE.WAIT) {
    effectiveChannels = ['ledger'];
  }
  if (actionType === AGENT_ACTION_TYPE.ENROLL_SEQUENCE) {
    effectiveChannels = ['email'];

    // D1: Activate multi-channel sequence policy modes.
    if (skripPolicy !== SKRIP_POLICY.EMAIL_ONLY) {
      const campaignId = campaignRef ?? 'agent-growth';
      const skripChannels = await resolveEligibleSkripChannels(env, tenantId, subjectId, campaignId);
      warnings.push(...skripChannels.warnings);
      evidence.sequenceSkripIdentityCount = skripChannels.identityCount;
      evidence.sequenceSkripChannelDecisions = skripChannels.channelDecisions;

      if (skripPolicy === SKRIP_POLICY.PUSH_ASSIST) {
        if (skripChannels.channels.includes('push')) {
          effectiveChannels = ['email', 'push'];
        }
      } else if (skripPolicy === SKRIP_POLICY.PUSH_PRIMARY_WITH_EMAIL_FALLBACK) {
        effectiveChannels = skripChannels.channels.includes('push') ? ['push', 'email'] : ['email'];
      } else if (skripPolicy === SKRIP_POLICY.MULTI_CHANNEL_PROGRESSIVE) {
        const unique = new Set<string>(['email', ...skripChannels.channels]);
        effectiveChannels = Array.from(unique);
      }

      if (effectiveChannels.length > 1) requiredApproval = true;
    }

    // When the isolated email channel authority flag is active, validate email
    // delivery authority through the Skrip channel_authorities table.
    // This scaffold is a no-op until SKRIP_EMAIL_AUTHORITY_ENABLED='true'.
    if (parseBoolean(env.SKRIP_EMAIL_AUTHORITY_ENABLED)) {
      const emailCampaignId = campaignRef ?? 'agent-growth';
      const emailChannelKillSwitch = await env.KV_MARKETING.get(
        `${GROWTH_POLICY.KILL_SWITCH_CHANNEL_PREFIX}${tenantId}:email`,
      );
      const emailDecision = await resolveSkripExecutionDecision(env, tenantId, emailCampaignId, 'email');
      evidence.emailChannelAuthority = {
        killed: parseBoolean(emailChannelKillSwitch),
        authority: emailDecision.authority,
        rolloutState: emailDecision.rolloutState,
        useSkrip: emailDecision.useSkrip,
      };
      if (parseBoolean(emailChannelKillSwitch)) {
        blockedReasons.push('email_channel_authority_kill_switch');
      }
      if (emailDecision.rolloutState === SKRIP_ROLLOUT_STATE.DRY_RUN) {
        warnings.push('email_skrip_authority_dry_run');
      }
      if (!emailDecision.useSkrip && !emailDecision.dryRun) {
        warnings.push('email_skrip_authority_not_enabled_fallback_to_legacy');
      }
    }
  }

  // B4: Outcome-calibrated threshold gate for low-risk auto-execution.
  const configuredThresholdRaw = await env.KV_MARKETING.get(
    `${GROWTH_POLICY.AUTONOMY_THRESHOLD_PREFIX}${actionType}:${tenantId}`,
  );
  const defaultThreshold = defaultAutonomyThresholdPct(actionType);
  const configuredThreshold = configuredThresholdRaw !== null
    ? Number.parseFloat(configuredThresholdRaw)
    : defaultThreshold;

  if (
    configuredThreshold !== null
    && Number.isFinite(configuredThreshold)
    && !isHighRisk(riskLevel)
    && blockedReasons.length === 0
  ) {
    const sinceEpoch = now() - 90 * 24 * 60 * 60;
    const [executedBase, conversionBase] = await Promise.all([
      queryOne<{ count: number }>(
        env.DB,
        `SELECT COUNT(*) AS count
           FROM agent_actions
          WHERE tenant_id = ?
            AND proposed_action = ?
            AND created_at >= ?
            AND status IN ('executed', 'outcome_observed', 'no_outcome_observed')`,
        [tenantId, actionType, sinceEpoch],
      ),
      queryOne<{ count: number }>(
        env.DB,
        `SELECT COUNT(*) AS count
           FROM agent_action_outcomes o
     INNER JOIN agent_actions a ON a.action_id = o.action_id
          WHERE a.tenant_id = ?
            AND a.proposed_action = ?
            AND o.outcome_type = 'conversion'
            AND o.observed_at >= ?`,
        [tenantId, actionType, sinceEpoch],
      ),
    ]);

    const totalExecuted = executedBase?.count ?? 0;
    const totalConverted = conversionBase?.count ?? 0;
    const conversionRatePct = totalExecuted > 0 ? (totalConverted * 100) / totalExecuted : 0;
    evidence.autonomyThreshold = {
      thresholdPct: configuredThreshold,
      windowDays: 90,
      totalExecuted,
      totalConverted,
      conversionRatePct,
    };
    if (conversionRatePct < configuredThreshold) {
      requiredApproval = true;
      warnings.push('autonomy_threshold_not_met');
    }
  }

  // ── Apply autonomy level override (after effectiveChannels is resolved) ──
  if (Number.isFinite(autonomyLevel)) {
    if (autonomyLevel <= 0) {
      // Level 0: operator must approve every execution.
      requiredApproval = true;
    } else if (autonomyLevel >= 3) {
      // Level 3: full autonomy — remove risk-based gate unless multi-channel.
      if (effectiveChannels.length <= 1) requiredApproval = false;
    }
    // Levels 1 and 2 keep the default risk-based requiredApproval logic.
  }

  return {
    allowed: blockedReasons.length === 0,
    blockedReasons,
    warnings,
    requiredApproval,
    effectiveChannels,
    cooldownUntil,
    evidence,
  };
}