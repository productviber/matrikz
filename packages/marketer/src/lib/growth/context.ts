import type { Env } from '../../types';
import { AGENT_ACTION_STATUS } from '../../constants';
import { now, query, queryOne } from '../db';
import { normalizeSubjectId, normalizeTenantId } from './common';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SubjectOutcomeSummary {
  actionId: string;
  actionType: string;
  confidence: number;
  outcomeType: string | null;
  attributionStrength: string | null;
  daysSinceExecution: number;
}

export interface SubjectChannelIdentity {
  channel: string;
  registrationState: string;
  availabilityState: string;
  consentState: string;
}

/**
 * Structural context about a subject used to inform the AI engine decision.
 * Contains only what the agent needs to reason — no raw PII blobs.
 *
 * emailEligible is set to true here as a structural hint; the policy layer
 * enforces the actual suppression/consent checks. It signals that the
 * subject's identifier is an email and therefore sequence enrollment is
 * in principle possible.
 */
export interface SubjectDecisionContext {
  recentOutcomes: SubjectOutcomeSummary[];
  activeSignalCount: number;
  signalTypesSeen: string[];
  lifecycleStage: string | null;
  pushRegistered: boolean;
  activeChannels: SubjectChannelIdentity[];
  emailEligible: boolean;
  lastActionType: string | null;
  lastActionDaysAgo: number | null;
}

// ─── Loader ──────────────────────────────────────────────────────────────────

/**
 * Loads structural subject context for use in AI engine decision requests.
 *
 * Runs four parallel DB reads:
 *   1. Last 5 executed actions with outcome type (LEFT JOIN agent_action_outcomes)
 *   2. Active growth signals for the subject
 *   3. Lifecycle stage from marketing_contacts (CRM status)
 *   4. Push channel registration check (contact_channel_identities)
 *
 * Intentionally lightweight: no raw email content, no PII blobs.
 * The policy layer enforces the authoritative eligibility checks.
 */
export async function getSubjectAllActiveChannels(
  env: Env,
  tenantId: string | null | undefined,
  subjectId: string,
): Promise<SubjectChannelIdentity[]> {
  const normalTenantId = normalizeTenantId(tenantId);
  const normalSubjectId = normalizeSubjectId(subjectId);

  return query<SubjectChannelIdentity>(
    env.DB,
    `SELECT channel, registration_state AS registrationState, availability_state AS availabilityState, consent_state AS consentState
       FROM contact_channel_identities
      WHERE tenant_id = ?
        AND external_contact_id = ?
        AND registration_state IN ('registered', 'active')
        AND availability_state IN ('available', 'reachable')
        AND consent_state IN ('opted_in', 'subscribed', 'granted')`,
    [normalTenantId, normalSubjectId],
  );
}

export async function loadSubjectContextForDecision(
  env: Env,
  tenantId: string | null | undefined,
  subjectId: string,
): Promise<SubjectDecisionContext> {
  const normalTenantId = normalizeTenantId(tenantId);
  const normalSubjectId = normalizeSubjectId(subjectId);
  const epochNow = now();

  const [recentActions, activeSignals, contact, activeChannels] = await Promise.all([
    // Last 5 executed/outcome actions with their outcome type
    query<{
      action_id: string;
      proposed_action: string;
      confidence: number;
      executed_at: number | null;
      outcome_type: string | null;
      attribution_strength: string | null;
    }>(
      env.DB,
      `SELECT aa.action_id, aa.proposed_action, aa.confidence, aa.executed_at, aao.outcome_type, aao.attribution_strength
         FROM agent_actions aa
        LEFT JOIN agent_action_outcomes aao ON aao.action_id = aa.action_id
        WHERE aa.tenant_id = ?
          AND aa.subject_id = ?
          AND aa.status IN (?, ?, ?)
        ORDER BY COALESCE(aa.executed_at, aa.created_at) DESC
        LIMIT 5`,
      [
        normalTenantId,
        normalSubjectId,
        AGENT_ACTION_STATUS.EXECUTED,
        AGENT_ACTION_STATUS.OUTCOME_OBSERVED,
        AGENT_ACTION_STATUS.NO_OUTCOME_OBSERVED,
      ],
    ),

    // Active signal types for compound reasoning
    query<{ signal_type: string }>(
      env.DB,
      `SELECT signal_type
         FROM growth_signals
        WHERE tenant_id = ?
          AND subject_id = ?
          AND status = 'active'
          AND expires_at > ?`,
      [normalTenantId, normalSubjectId, epochNow],
    ),

    // Lifecycle stage from CRM (nil-safe — subject may not be a contact yet)
    queryOne<{ status: string }>(
      env.DB,
      `SELECT status FROM marketing_contacts WHERE email = ? LIMIT 1`,
      [normalSubjectId],
    ),

    // Active channel projection across product-user identities.
    getSubjectAllActiveChannels(env, tenantId, subjectId),
  ]);

  const recentOutcomes: SubjectOutcomeSummary[] = recentActions.map((row) => ({
    actionId: row.action_id,
    actionType: row.proposed_action,
    confidence: row.confidence,
    outcomeType: row.outcome_type ?? null,
    attributionStrength: row.attribution_strength ?? null,
    daysSinceExecution: row.executed_at
      ? Math.floor((epochNow - row.executed_at) / (24 * 60 * 60))
      : 0,
  }));

  const lastAction = recentActions[0] ?? null;
  const activeChannelIds = activeChannels.map((row) => row.channel);

  return {
    recentOutcomes,
    activeSignalCount: activeSignals.length,
    signalTypesSeen: activeSignals.map((s) => s.signal_type),
    lifecycleStage: contact?.status ?? null,
    pushRegistered: activeChannelIds.includes('push'),
    activeChannels,
    emailEligible: true,
    lastActionType: lastAction?.proposed_action ?? null,
    lastActionDaysAgo: lastAction?.executed_at
      ? Math.floor((epochNow - lastAction.executed_at) / (24 * 60 * 60))
      : null,
  };
}
