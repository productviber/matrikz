/**
 * Governance Execution Client
 *
 * Reusable client that applies governance checks to state-changing execution
 * actions (enroll_sequence, send_via_skrip, start_campaign, pause_campaign,
 * pause_contact, channel subscribe flows).
 *
 * Mode resolution (highest-priority first):
 *   1. KV override key `gov:exec:mode-override`
 *   2. GOVERNANCE_EXECUTION_MODE env var
 *   3. Default: 'off' (safe fail-open for undeployed service)
 *
 * Behaviour per mode:
 *   off     — bypass entirely, return allowed: true, enforcementOutcome: 'bypassed'
 *   observe — call governance service (if configured); never block regardless of decision;
 *             record violation flag when decision.allowed === false
 *   enforce — call governance service (if configured); block when decision.allowed === false;
 *             fail-open on infrastructure errors (network_error, non_200, malformed_response)
 *             to prevent cascading outages from a governance service hiccup
 *
 * Governance service availability:
 *   - Configured when env.GOVERNANCE (Fetcher) or env.GOVERNANCE_URL is set
 *   - Unconfigured: reason='governance_unavailable', allowed=true regardless of mode
 *
 * All decisions are persisted to governance_execution_decisions for auditability.
 */

import type { Env } from '../types';
import {
  GOVERNANCE_EXECUTION_CONFIG,
  GOVERNANCE_EXECUTION_MODE,
  KV_PREFIX,
} from '../constants';
import { execute } from './db';
import { getCorrelationId } from './correlation';
import { verifyGovernanceToken, isPolicyVersionFresh } from './governance-token-utils';

// ─── Public Types ──────────────────────────────────────────────────────────

export type GovernanceExecutionMode =
  | typeof GOVERNANCE_EXECUTION_MODE.OFF
  | typeof GOVERNANCE_EXECUTION_MODE.OBSERVE
  | typeof GOVERNANCE_EXECUTION_MODE.ENFORCE;

export type GovernanceExecutionReason =
  | 'bypass_mode_off'
  | 'governance_unavailable'
  | 'allowed_by_service'
  | 'denied_by_service'
  | 'network_error'
  | 'non_200_response'
  | 'malformed_response'
  | 'token_verification_failed'
  | 'token_expired'
  | 'stale_policy_version';

export type GovernanceExecutionOutcome =
  | 'bypassed'
  | 'allowed'
  | 'blocked'
  | 'observed';

export interface GovernanceExecutionDecision {
  decisionId: string;
  governanceMode: GovernanceExecutionMode;
  actionType: string;
  actorTenantId: string | null;
  targetTenantId: string | null;
  tenantScope: string | null;
  allowed: boolean;
  enforcementOutcome: GovernanceExecutionOutcome;
  reason: GovernanceExecutionReason;
  policyVersion: string | null;
  signedDecisionToken: string | null;
  violation: boolean;
}

export interface GovernanceExecutionInput {
  actionType: string;
  actorTenantId?: string | null;
  targetTenantId?: string | null;
  subjectId?: string | null;
  context?: Record<string, unknown>;
}

// ─── Internal ─────────────────────────────────────────────────────────────

interface GovernanceServiceResponse {
  allowed: boolean;
  decisionId?: string | null;
  signedDecisionToken?: string | null;
  reason?: string | null;
  policyVersion?: string | null;
  enforcementOutcome?: string | null;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function normalizeMode(rawMode?: string): GovernanceExecutionMode {
  const mode = (rawMode ?? '').toLowerCase().trim();
  if (mode === GOVERNANCE_EXECUTION_MODE.ENFORCE) return GOVERNANCE_EXECUTION_MODE.ENFORCE;
  if (mode === GOVERNANCE_EXECUTION_MODE.OBSERVE) return GOVERNANCE_EXECUTION_MODE.OBSERVE;
  return GOVERNANCE_EXECUTION_MODE.OFF;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveExecutionMode(env: any): Promise<GovernanceExecutionMode> {
  try {
    const kvOverride = await env.KV_MARKETING.get(KV_PREFIX.GOVERNANCE_EXECUTION_MODE_OVERRIDE);
    if (kvOverride) {
      return normalizeMode(kvOverride);
    }
  } catch {
    // KV unavailable — fall through to env var
  }
  return normalizeMode(env.GOVERNANCE_EXECUTION_MODE);
}

function isGovernanceConfigured(env: Env): boolean {
  return !!(env.GOVERNANCE || (env.GOVERNANCE_URL && env.GOVERNANCE_URL.trim().length > 0));
}

async function callGovernanceService(
  env: Env,
  actionType: string,
  input: GovernanceExecutionInput,
): Promise<{ ok: boolean; data?: GovernanceServiceResponse; errorReason?: GovernanceExecutionReason }> {
  const internalSecret = env.INTERNAL_SECRET ?? null;
  const tenantId = input.targetTenantId ?? input.actorTenantId ?? 'default';

  // Determine endpoint path by action class
  const path = actionType === 'enroll_sequence'
    ? GOVERNANCE_EXECUTION_CONFIG.ENDPOINT_ENROLLMENT
    : GOVERNANCE_EXECUTION_CONFIG.ENDPOINT_OUTBOUND;

  const requestBody = JSON.stringify({
    actionType,
    actorTenantId: input.actorTenantId ?? null,
    targetTenantId: input.targetTenantId ?? null,
    subjectId: input.subjectId ?? null,
    context: input.context ?? {},
    correlationId: getCorrelationId(),
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [GOVERNANCE_EXECUTION_CONFIG.TENANT_HEADER]: tenantId,
  };
  if (internalSecret) {
    headers[GOVERNANCE_EXECUTION_CONFIG.AUTH_HEADER] = internalSecret;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    GOVERNANCE_EXECUTION_CONFIG.DEFAULT_TIMEOUT_MS,
  );

  try {
    let response: Response;

    if (env.GOVERNANCE) {
      response = await (env.GOVERNANCE as unknown as { fetch: (url: string | URL, init?: RequestInit) => Promise<Response> }).fetch(
        `https://governance.internal${path}`,
        { method: 'POST', headers, body: requestBody, signal: controller.signal },
      );
    } else {
      const url = new URL(path, env.GOVERNANCE_URL!).toString();
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: controller.signal,
      });
    }

    clearTimeout(timer);

    if (!response.ok) {
      return { ok: false, errorReason: 'non_200_response' };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { ok: false, errorReason: 'malformed_response' };
    }

    if (
      typeof data !== 'object' ||
      data === null ||
      typeof (data as Record<string, unknown>).allowed !== 'boolean'
    ) {
      return { ok: false, errorReason: 'malformed_response' };
    }

    return { ok: true, data: data as GovernanceServiceResponse };
  } catch {
    clearTimeout(timer);
    return { ok: false, errorReason: 'network_error' };
  }
}

async function persistDecision(env: Env, decision: GovernanceExecutionDecision): Promise<void> {
  try {
    const epoch = Math.floor(Date.now() / 1000);
    await execute(
      env.DB,
      `INSERT INTO governance_execution_decisions
        (decision_id, governance_mode, action_type, actor_tenant_id, target_tenant_id,
         tenant_scope, allowed, enforcement_outcome, reason, policy_version,
         token_present, violation, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(decision_id) DO NOTHING`,
      [
        decision.decisionId,
        decision.governanceMode,
        decision.actionType,
        decision.actorTenantId,
        decision.targetTenantId,
        decision.tenantScope ?? decision.targetTenantId ?? decision.actorTenantId,
        decision.allowed ? 1 : 0,
        decision.enforcementOutcome,
        decision.reason,
        decision.policyVersion,
        decision.signedDecisionToken ? 1 : 0,
        decision.violation ? 1 : 0,
        epoch,
      ],
    );
  } catch (err) {
    // Non-fatal: audit trail failure must not block execution
    console.warn('[GovernanceExecution] Failed to persist decision:', err instanceof Error ? err.message : err);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Evaluate governance for a state-changing execution action.
 *
 * Returns a GovernanceExecutionDecision. The `allowed` field reflects
 * whether the action should proceed:
 *   - In 'off' mode: always true
 *   - In 'observe' mode: always true (violation flag set when service says denied)
 *   - In 'enforce' mode: reflects actual service decision (fail-open on errors)
 *
 * Always persists to governance_execution_decisions for auditability.
 */
export async function evaluateGovernanceExecution(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  env: any,
  input: GovernanceExecutionInput,
): Promise<GovernanceExecutionDecision> {
  const mode = await resolveExecutionMode(env);
  const decisionId = `gexec_${randomSuffix()}`;

  // Mode: off — bypass
  if (mode === GOVERNANCE_EXECUTION_MODE.OFF) {
    const decision: GovernanceExecutionDecision = {
      decisionId,
      governanceMode: mode,
      actionType: input.actionType,
      actorTenantId: input.actorTenantId ?? null,
      targetTenantId: input.targetTenantId ?? null,
      tenantScope: input.targetTenantId ?? input.actorTenantId ?? null,
      allowed: true,
      enforcementOutcome: 'bypassed',
      reason: 'bypass_mode_off',
      policyVersion: null,
      signedDecisionToken: null,
      violation: false,
    };
    await persistDecision(env, decision);
    return decision;
  }

  // Mode: observe or enforce — try to call governance service
  if (!isGovernanceConfigured(env)) {
    const decision: GovernanceExecutionDecision = {
      decisionId,
      governanceMode: mode,
      actionType: input.actionType,
      actorTenantId: input.actorTenantId ?? null,
      targetTenantId: input.targetTenantId ?? null,
      tenantScope: input.targetTenantId ?? input.actorTenantId ?? null,
      allowed: true,
      enforcementOutcome: mode === GOVERNANCE_EXECUTION_MODE.ENFORCE ? 'allowed' : 'observed',
      reason: 'governance_unavailable',
      policyVersion: null,
      signedDecisionToken: null,
      violation: false,
    };
    console.warn(
      `[GovernanceExecution] mode=${mode} but no GOVERNANCE binding/URL configured; ` +
      `action=${input.actionType} — failing open (governance_unavailable)`,
    );
    await persistDecision(env, decision);
    return decision;
  }

  // Call governance service
  const callResult = await callGovernanceService(env, input.actionType, input);

  if (!callResult.ok) {
    // Infrastructure error — always fail-open
    const reason = callResult.errorReason ?? 'network_error';
    const decision: GovernanceExecutionDecision = {
      decisionId,
      governanceMode: mode,
      actionType: input.actionType,
      actorTenantId: input.actorTenantId ?? null,
      targetTenantId: input.targetTenantId ?? null,
      tenantScope: input.targetTenantId ?? input.actorTenantId ?? null,
      allowed: true,
      enforcementOutcome: mode === GOVERNANCE_EXECUTION_MODE.ENFORCE ? 'allowed' : 'observed',
      reason,
      policyVersion: null,
      signedDecisionToken: null,
      violation: false,
    };
    console.error(
      `[GovernanceExecution] service call failed: reason=${reason}, mode=${mode}, action=${input.actionType} — failing open`,
    );
    await persistDecision(env, decision);
    return decision;
  }

  const serviceDecision = callResult.data!;
  const serviceAllowed = serviceDecision.allowed;
  const serviceDecisionId = serviceDecision.decisionId ?? decisionId;
  const violation = !serviceAllowed;

  // Token Verification (in enforce mode)
  let tokenVerificationFailed = false;
  let tokenVerificationReason: GovernanceExecutionReason = 'allowed_by_service';

  if (mode === GOVERNANCE_EXECUTION_MODE.ENFORCE && serviceDecision.signedDecisionToken) {
    const signingKey = env.GOVERNANCE_SIGNING_KEY ?? null;

    if (!signingKey) {
      // No signing key configured — cannot verify tokens
      // This is a configuration issue, not a security issue, so fail-open with warning
      console.warn(
        `[GovernanceExecution] Governance signing key not configured; ` +
        `cannot verify token signatures. Set GOVERNANCE_SIGNING_KEY environment variable. ` +
        `Allowing action in enforce mode (fail-open).`,
      );
    } else {
      const tokenVerification = await verifyGovernanceToken(
        serviceDecision.signedDecisionToken,
        signingKey,
      );

      if (!tokenVerification.valid) {
        tokenVerificationFailed = true;
        tokenVerificationReason =
          tokenVerification.reason === 'token_expired'
            ? 'token_expired'
            : 'token_verification_failed';

        console.error(
          `[GovernanceExecution] Token verification failed: reason=${tokenVerification.reason}, ` +
          `mode=${mode}, action=${input.actionType}, decisionId=${serviceDecisionId}`,
        );

        // In enforce mode with bad token: block the action
        const decision: GovernanceExecutionDecision = {
          decisionId: serviceDecisionId,
          governanceMode: mode,
          actionType: input.actionType,
          actorTenantId: input.actorTenantId ?? null,
          targetTenantId: input.targetTenantId ?? null,
          tenantScope: input.targetTenantId ?? input.actorTenantId ?? null,
          allowed: false,
          enforcementOutcome: 'blocked',
          reason: tokenVerificationReason,
          policyVersion: serviceDecision.policyVersion ?? null,
          signedDecisionToken: serviceDecision.signedDecisionToken ?? null,
          violation: true,
        };
        await persistDecision(env, decision);
        return decision;
      }
    }
  }

  // Policy Freshness Check (in enforce mode)
  let stalePolicyRejected = false;

  if (mode === GOVERNANCE_EXECUTION_MODE.ENFORCE && serviceDecision.policyVersion) {
    const localPolicyVersion = env.GOVERNANCE_POLICY_VERSION ?? null;
    if (localPolicyVersion && !isPolicyVersionFresh(serviceDecision.policyVersion, localPolicyVersion)) {
      stalePolicyRejected = true;

      console.error(
        `[GovernanceExecution] Stale policy version detected: received=${serviceDecision.policyVersion}, ` +
        `local=${localPolicyVersion}, mode=${mode}, action=${input.actionType}`,
      );

      // In enforce mode with stale policy: block the action
      const decision: GovernanceExecutionDecision = {
        decisionId: serviceDecisionId,
        governanceMode: mode,
        actionType: input.actionType,
        actorTenantId: input.actorTenantId ?? null,
        targetTenantId: input.targetTenantId ?? null,
        tenantScope: input.targetTenantId ?? input.actorTenantId ?? null,
        allowed: false,
        enforcementOutcome: 'blocked',
        reason: 'stale_policy_version',
        policyVersion: serviceDecision.policyVersion ?? null,
        signedDecisionToken: serviceDecision.signedDecisionToken ?? null,
        violation: true,
      };
      await persistDecision(env, decision);
      return decision;
    }
  }

  // In observe mode: allow regardless, record violation
  // In enforce mode: respect the service decision (now with token + policy freshness verified)
  const finalAllowed = mode === GOVERNANCE_EXECUTION_MODE.OBSERVE ? true : serviceAllowed;
  const enforcementOutcome: GovernanceExecutionOutcome =
    mode === GOVERNANCE_EXECUTION_MODE.OBSERVE
      ? 'observed'
      : serviceAllowed
        ? 'allowed'
        : 'blocked';

  const decision: GovernanceExecutionDecision = {
    decisionId: serviceDecisionId,
    governanceMode: mode,
    actionType: input.actionType,
    actorTenantId: input.actorTenantId ?? null,
    targetTenantId: input.targetTenantId ?? null,
    tenantScope: input.targetTenantId ?? input.actorTenantId ?? null,
    allowed: finalAllowed,
    enforcementOutcome,
    reason: serviceAllowed ? 'allowed_by_service' : 'denied_by_service',
    policyVersion: serviceDecision.policyVersion ?? null,
    signedDecisionToken: serviceDecision.signedDecisionToken ?? null,
    violation,
  };

  if (violation && mode === GOVERNANCE_EXECUTION_MODE.OBSERVE) {
    console.warn(
      `[GovernanceExecution] observe-mode violation: action=${input.actionType}, ` +
      `tenantId=${input.targetTenantId ?? input.actorTenantId}, decisionId=${serviceDecisionId}`,
    );
  }

  await persistDecision(env, decision);
  return decision;
}

/**
 * Resolve the currently active governance execution mode, accounting for
 * KV override. Used by admin status endpoints.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveGovernanceExecutionMode(env: any): Promise<GovernanceExecutionMode> {
  return resolveExecutionMode(env);
}
