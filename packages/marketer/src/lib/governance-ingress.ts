import type { Env, EventEnvelope, ForwardedAuthorityContext } from '../types';
import { EVENT_SECURITY, GOVERNANCE_INGRESS_MODE, KV_PREFIX } from '../constants';
import { execute } from './db';
import { logEvent } from './observability';

export type GovernanceIngressMode =
  | typeof GOVERNANCE_INGRESS_MODE.OFF
  | typeof GOVERNANCE_INGRESS_MODE.OBSERVE
  | typeof GOVERNANCE_INGRESS_MODE.ENFORCE;

export type GovernanceReason =
  | 'bypass_mode_off'
  | 'authority_context_absent'
  | 'authority_context_valid'
  | 'authority_context_malformed'
  | 'authority_context_missing_decision_id'
  | 'authority_context_missing_source'
  | 'authority_context_missing_allowed'
  | 'authority_context_untrusted_source'
  | 'authority_context_denied'
  | 'authority_context_target_tenant_required'
  | 'authority_context_target_tenant_mismatch'
  | 'duplicate_decision_suppressed';

export type GovernanceOutcome =
  | 'bypassed'
  | 'observed'
  | 'allowed'
  | 'blocked'
  | 'duplicate_suppressed';

export interface GovernanceIngressDecision {
  decisionId: string;
  governanceMode: GovernanceIngressMode;
  ingressSource: string;
  authoritySource: string | null;
  allowed: boolean;
  enforcementOutcome: GovernanceOutcome;
  reason: GovernanceReason;
  actorTenantId: string | null;
  targetTenantId: string | null;
  tenantScope: string | null;
  eventType: string;
  actionType: string | null;
  violation: boolean;
  duplicateSuppressed: boolean;
}

interface ValidationResult {
  context: ForwardedAuthorityContext | null;
  reason: GovernanceReason;
}

interface GovernancePolicy {
  allowedAuthoritySources: Set<string>;
  enforceActionTypes: Set<string>;
  requireTargetTenantActionTypes: Set<string>;
}

const DEFAULT_ALLOWED_AUTHORITY_SOURCES = ['visibility-analytics'];
const DEFAULT_REQUIRE_TARGET_TENANT_ACTION_TYPES = [
  'enroll_sequence',
  'send_via_skrip',
  'pause_campaign',
  'start_campaign',
  'pause_contact',
  'campaign.start',
  'campaign.pause',
  'contact.pause',
];

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeMode(rawMode?: string): GovernanceIngressMode {
  const mode = (rawMode ?? '').toLowerCase().trim();
  if (mode === GOVERNANCE_INGRESS_MODE.ENFORCE) return GOVERNANCE_INGRESS_MODE.ENFORCE;
  if (mode === GOVERNANCE_INGRESS_MODE.OBSERVE) return GOVERNANCE_INGRESS_MODE.OBSERVE;
  return GOVERNANCE_INGRESS_MODE.OFF;
}

function parseCsvSet(value: string | undefined, fallback: string[]): Set<string> {
  const raw = (value ?? '').trim();
  const source = raw.length > 0 ? raw.split(',') : fallback;
  return new Set(
    source
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0),
  );
}

function buildPolicy(env: Env): GovernancePolicy {
  return {
    allowedAuthoritySources: parseCsvSet(
      env.GOVERNANCE_ALLOWED_AUTHORITY_SOURCES,
      DEFAULT_ALLOWED_AUTHORITY_SOURCES,
    ),
    enforceActionTypes: parseCsvSet(env.GOVERNANCE_ENFORCE_ACTIONS, []),
    requireTargetTenantActionTypes: parseCsvSet(
      env.GOVERNANCE_REQUIRE_TARGET_TENANT_ACTIONS,
      DEFAULT_REQUIRE_TARGET_TENANT_ACTION_TYPES,
    ),
  };
}

/**
 * Returns a serializable representation of the active policy configuration
 * for use in admin status endpoints.
 */
export function buildGovernancePolicyInfo(env: Env): {
  allowedAuthoritySources: string[];
  enforceActionTypes: string[];
  requireTargetTenantActionTypes: string[];
} {
  const policy = buildPolicy(env);
  return {
    allowedAuthoritySources: [...policy.allowedAuthoritySources],
    enforceActionTypes: [...policy.enforceActionTypes],
    requireTargetTenantActionTypes: [...policy.requireTargetTenantActionTypes],
  };
}

function isActionListed(actionType: string | null, list: Set<string>): boolean {
  if (list.size === 0) return false;
  if (!actionType) return false;
  return list.has(actionType.toLowerCase());
}

function readAuthorityContext(envelope: EventEnvelope): unknown {
  // Try canonical locations first (new shape)
  const fromEnvelope = (envelope as EventEnvelope & { authorityContext?: unknown }).authorityContext;
  if (fromEnvelope !== undefined) return fromEnvelope;

  // Try legacy locations
  const legacy = (envelope as EventEnvelope & { authority?: unknown }).authority;
  if (legacy !== undefined) return legacy;

  const data = envelope.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return undefined;

  // Try canonical data.authorityContext (new shape sent by analytics)
  if (data.authorityContext !== undefined) return data.authorityContext;

  // Try legacy data.authority
  if (data.authority !== undefined) return data.authority;

  // Legacy fields from analytics (underscore-prefixed, used to construct context)
  const legacyDecisionId = data._authorityDecisionId;
  const legacyToken = data._authorityDecisionToken;
  if (legacyDecisionId) {
    return {
      decisionId: legacyDecisionId,
      signedDecisionToken: legacyToken || null,
      actionType: data._actionType || null,
      hash: data._authorityHash || null,
      issuedAt: data._sourceOccurredAt || null,
    };
  }

  return undefined;
}

function extractTargetTenant(envelope: EventEnvelope, request: Request): string | null {
  const headerTenant = normalizeText(request.headers.get('x-vm-tenant-id'));
  if (headerTenant) return headerTenant;

  const data = envelope.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return null;

  const tenantId = normalizeText(data.tenantId);
  if (tenantId) return tenantId;
  return normalizeText(data.tenant_id);
}

function extractActionType(envelope: EventEnvelope): string | null {
  const data = envelope.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return null;
  const actionType = normalizeText(data.actionType);
  if (actionType) return actionType;
  return normalizeText(data.action_type);
}

function validateAuthorityContext(
  envelope: EventEnvelope,
  request: Request,
  policy: GovernancePolicy,
): ValidationResult {
  const raw = readAuthorityContext(envelope);
  if (raw === undefined || raw === null) {
    return { context: null, reason: 'authority_context_absent' };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { context: null, reason: 'authority_context_malformed' };
  }

  const candidate = raw as Record<string, unknown>;
  const decisionId = normalizeText(candidate.decisionId) ?? normalizeText(candidate.decision_id);
  if (!decisionId) {
    return { context: null, reason: 'authority_context_missing_decision_id' };
  }

  const source = normalizeText(candidate.source);
  if (!source) {
    return { context: null, reason: 'authority_context_missing_source' };
  }

  if (typeof candidate.allowed !== 'boolean') {
    return { context: null, reason: 'authority_context_missing_allowed' };
  }

  const normalizedSource = source.toLowerCase();
  if (!policy.allowedAuthoritySources.has(normalizedSource)) {
    return { context: null, reason: 'authority_context_untrusted_source' };
  }

  const context: ForwardedAuthorityContext = {
    decisionId,
    source,
    allowed: candidate.allowed,
    actorTenantId:
      normalizeText(candidate.actorTenantId) ?? normalizeText(candidate.actor_tenant_id) ?? undefined,
    targetTenantId:
      normalizeText(candidate.targetTenantId) ?? normalizeText(candidate.target_tenant_id) ?? undefined,
    lineage:
      candidate.lineage && typeof candidate.lineage === 'object' && !Array.isArray(candidate.lineage)
        ? candidate.lineage as Record<string, unknown>
        : undefined,
  };

  const targetTenant = extractTargetTenant(envelope, request);
  const actionType = extractActionType(envelope);
  if (isActionListed(actionType, policy.requireTargetTenantActionTypes) && !context.targetTenantId) {
    return { context, reason: 'authority_context_target_tenant_required' };
  }

  if (targetTenant && context.targetTenantId && targetTenant !== context.targetTenantId) {
    return { context, reason: 'authority_context_target_tenant_mismatch' };
  }

  if (!context.allowed) {
    return { context, reason: 'authority_context_denied' };
  }

  return { context, reason: 'authority_context_valid' };
}

/**
 * Resolves the active governance mode by checking for a KV-based emergency
 * override before falling back to the GOVERNANCE_INGRESS_MODE env var.
 * The KV override allows operators to change mode without redeployment.
 */
export async function resolveGovernanceMode(env: Env): Promise<GovernanceIngressMode> {
  try {
    const kvOverride = await env.KV_MARKETING.get(KV_PREFIX.GOVERNANCE_MODE_OVERRIDE);
    if (kvOverride) {
      const normalized = kvOverride.trim().toLowerCase();
      if (
        normalized === GOVERNANCE_INGRESS_MODE.OFF ||
        normalized === GOVERNANCE_INGRESS_MODE.OBSERVE ||
        normalized === GOVERNANCE_INGRESS_MODE.ENFORCE
      ) {
        return normalized as GovernanceIngressMode;
      }
    }
  } catch {
    // KV unavailable — fall through to env var
  }
  return normalizeMode(env.GOVERNANCE_INGRESS_MODE);
}

export function evaluateGovernanceIngress(
  envelope: EventEnvelope,
  request: Request,
  env: Env,
  modeOverride?: GovernanceIngressMode,
): GovernanceIngressDecision {
  const governanceMode = modeOverride ?? normalizeMode(env.GOVERNANCE_INGRESS_MODE);
  const policy = buildPolicy(env);
  const ingressSource = normalizeText(envelope.source) ?? 'unknown';
  const actionType = extractActionType(envelope);
  const targetTenant = extractTargetTenant(envelope, request);
  const validation = validateAuthorityContext(envelope, request, policy);
  const syntheticDecisionId = `gov_${Date.now()}_${randomSuffix()}`;

  if (governanceMode === GOVERNANCE_INGRESS_MODE.OFF) {
    return {
      decisionId: validation.context?.decisionId ?? syntheticDecisionId,
      governanceMode,
      ingressSource,
      authoritySource: validation.context?.source ?? null,
      allowed: true,
      enforcementOutcome: 'bypassed',
      reason: 'bypass_mode_off',
      actorTenantId: validation.context?.actorTenantId ?? null,
      targetTenantId: validation.context?.targetTenantId ?? targetTenant,
      tenantScope: targetTenant,
      eventType: envelope.event,
      actionType,
      violation: false,
      duplicateSuppressed: false,
    };
  }

  const enforceForAction = governanceMode === GOVERNANCE_INGRESS_MODE.ENFORCE
    && (policy.enforceActionTypes.size === 0 || isActionListed(actionType, policy.enforceActionTypes));

  const violation = validation.reason !== 'authority_context_valid';
  const blocked = enforceForAction
    && violation
    && validation.reason !== 'authority_context_absent';

  return {
    decisionId: validation.context?.decisionId ?? syntheticDecisionId,
    governanceMode,
    ingressSource,
    authoritySource: validation.context?.source ?? null,
    allowed: !blocked,
    enforcementOutcome: blocked ? 'blocked' : 'observed',
    reason: validation.reason,
    actorTenantId: validation.context?.actorTenantId ?? null,
    targetTenantId: validation.context?.targetTenantId ?? targetTenant,
    tenantScope: targetTenant,
    eventType: envelope.event,
    actionType,
    violation,
    duplicateSuppressed: false,
  };
}

export async function detectDuplicateGovernanceDecision(
  env: Env,
  decision: GovernanceIngressDecision,
): Promise<boolean> {
  if (!decision.authoritySource) return false;
  if (!decision.decisionId) return false;

  const tenantScope = decision.tenantScope ?? '_none';
  const actionType = decision.actionType ?? '_none';
  const replayKey = `${KV_PREFIX.AUTH_NONCE}gov-ingress:dup:${tenantScope}:${decision.decisionId}:${decision.eventType}:${actionType}`;
  const seen = await env.KV_MARKETING.get(replayKey);
  if (seen) return true;

  await env.KV_MARKETING.put(replayKey, '1', { expirationTtl: EVENT_SECURITY.REPLAY_TTL_SECS });
  return false;
}

export function withDuplicateSuppressedDecision(
  decision: GovernanceIngressDecision,
): GovernanceIngressDecision {
  return {
    ...decision,
    allowed: true,
    violation: false,
    duplicateSuppressed: true,
    enforcementOutcome: 'duplicate_suppressed',
    reason: 'duplicate_decision_suppressed',
  };
}

export async function writeGovernanceIngressDecision(
  env: Env,
  decision: GovernanceIngressDecision,
): Promise<void> {
  try {
    await execute(
      env.DB,
      `INSERT INTO governance_ingress_decisions
        (decision_id, governance_mode, ingress_source, authority_source, allowed,
         enforcement_outcome, reason, actor_tenant_id, target_tenant_id, tenant_scope,
         event_type, action_type, violation, duplicate_suppressed, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        decision.decisionId,
        decision.governanceMode,
        decision.ingressSource,
        decision.authoritySource,
        decision.allowed ? 1 : 0,
        decision.enforcementOutcome,
        decision.reason,
        decision.actorTenantId,
        decision.targetTenantId,
        decision.tenantScope,
        decision.eventType,
        decision.actionType,
        decision.violation ? 1 : 0,
        decision.duplicateSuppressed ? 1 : 0,
        Math.floor(Date.now() / 1000),
      ],
    );
  } catch {
    // Governance observability must never fail closed.
  }

  await logEvent(env, 'governance.ingress.decision', {
    decisionId: decision.decisionId,
    mode: decision.governanceMode,
    ingressSource: decision.ingressSource,
    authoritySource: decision.authoritySource,
    allowed: decision.allowed,
    enforcementOutcome: decision.enforcementOutcome,
    reason: decision.reason,
    actorTenantId: decision.actorTenantId,
    targetTenantId: decision.targetTenantId,
    eventType: decision.eventType,
    actionType: decision.actionType,
    duplicateSuppressed: decision.duplicateSuppressed,
  }, decision.allowed ? 'info' : 'warn').catch(() => {
    // Non-fatal telemetry path.
  });
}

export async function evaluateAndGuardGovernanceIngress(
  envelope: EventEnvelope,
  request: Request,
  env: Env,
): Promise<GovernanceIngressDecision> {
  const resolvedMode = await resolveGovernanceMode(env);
  const initialDecision = evaluateGovernanceIngress(envelope, request, env, resolvedMode);

  if (!initialDecision.authoritySource) {
    return initialDecision;
  }

  const duplicate = await detectDuplicateGovernanceDecision(env, initialDecision);
  if (!duplicate) return initialDecision;

  return withDuplicateSuppressedDecision(initialDecision);
}