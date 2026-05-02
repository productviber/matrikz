import type { Env, ProposedAgentAction } from '../../types';
import { AGENT_ACTION_TYPE, AGENT_RISK_LEVEL, AI_ENGINE_CONFIG, CONTENT_TYPE_JSON, KV_PREFIX, TTL } from '../../constants';
import { getCorrelationId } from '../correlation';
import { normalizeTenantId, stableStringify } from '../growth/common';

export interface AiEngineMetadata {
  provider: string | null;
  model: string | null;
  capability: string;
  promptVersion: string;
  responseSchemaVersion: string;
  latencyMs: number;
  tokenEstimate: number | null;
  costEstimate: number | null;
  fallback: boolean;
  error?: string;
}

export interface GrowthNextActionRequest {
  tenantId?: string | null;
  subjectId: string;
  signals: unknown[];
  context: Record<string, unknown>;
}

export interface GrowthNextActionResult {
  action: ProposedAgentAction;
  riskLevel: string;
  confidence: number;
  explanation: string;
  metadata: AiEngineMetadata;
  rawSummary: Record<string, unknown>;
}

export interface AiEngineResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

type GrowthCapability =
  | 'growth-next-action'
  | 'growth-signal-summarize'
  | 'journey-critic'
  | 'message-brief'
  | 'outcome-diagnose';

function configuredTimeout(env: Env): number {
  const parsed = Number.parseInt(env.AI_ENGINE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : AI_ENGINE_CONFIG.DEFAULT_TIMEOUT_MS;
}

async function readCircuitOpenUntil(env: Env): Promise<number> {
  const raw = await env.KV_MARKETING.get(`${KV_PREFIX.AI_ENGINE_CIRCUIT}default`);
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

async function recordFailure(env: Env): Promise<void> {
  const key = `${KV_PREFIX.AI_ENGINE_FAILURE}default`;
  const current = Number.parseInt((await env.KV_MARKETING.get(key)) ?? '0', 10);
  const next = (Number.isFinite(current) ? current : 0) + 1;
  await env.KV_MARKETING.put(key, String(next), { expirationTtl: TTL.DAYS_1 });
  if (next >= AI_ENGINE_CONFIG.CIRCUIT_FAILURE_THRESHOLD) {
    const openUntil = Date.now() + AI_ENGINE_CONFIG.CIRCUIT_OPEN_TTL_SECS * 1000;
    await env.KV_MARKETING.put(
      `${KV_PREFIX.AI_ENGINE_CIRCUIT}default`,
      String(openUntil),
      { expirationTtl: AI_ENGINE_CONFIG.CIRCUIT_OPEN_TTL_SECS },
    );
  }
}

async function clearFailures(env: Env): Promise<void> {
  await env.KV_MARKETING.delete(`${KV_PREFIX.AI_ENGINE_FAILURE}default`);
  await env.KV_MARKETING.delete(`${KV_PREFIX.AI_ENGINE_CIRCUIT}default`);
}

function fallbackMetadata(capability: GrowthCapability, latencyMs: number, error?: string): AiEngineMetadata {
  return {
    provider: null,
    model: null,
    capability,
    promptVersion: AI_ENGINE_CONFIG.CAPABILITY_VERSION,
    responseSchemaVersion: AI_ENGINE_CONFIG.RESPONSE_SCHEMA_VERSION,
    latencyMs,
    tokenEstimate: null,
    costEstimate: null,
    fallback: true,
    error,
  };
}

function metadataFromResponse(capability: GrowthCapability, response: Record<string, unknown>, latencyMs: number): AiEngineMetadata {
  const metadata = typeof response.metadata === 'object' && response.metadata !== null
    ? response.metadata as Record<string, unknown>
    : {};
  return {
    provider: typeof metadata.provider === 'string' ? metadata.provider : null,
    model: typeof metadata.model === 'string' ? metadata.model : null,
    capability,
    promptVersion: typeof metadata.promptVersion === 'string' ? metadata.promptVersion : AI_ENGINE_CONFIG.CAPABILITY_VERSION,
    responseSchemaVersion: typeof metadata.responseSchemaVersion === 'string'
      ? metadata.responseSchemaVersion
      : AI_ENGINE_CONFIG.RESPONSE_SCHEMA_VERSION,
    latencyMs,
    tokenEstimate: typeof metadata.tokenEstimate === 'number' ? metadata.tokenEstimate : null,
    costEstimate: typeof metadata.costEstimate === 'number' ? metadata.costEstimate : null,
    fallback: false,
  };
}

async function requestCapability<T>(
  env: Env,
  capability: GrowthCapability,
  payload: Record<string, unknown>,
): Promise<AiEngineResult<T>> {
  if (!env.AI_ENGINE) {
    return { ok: false, error: 'AI_ENGINE binding is not configured' };
  }

  const openUntil = await readCircuitOpenUntil(env);
  if (openUntil > Date.now()) {
    return { ok: false, error: 'ai-engine circuit breaker is open' };
  }

  const url = `https://ai-engine/internal/${capability}`;
  const timeoutMs = configuredTimeout(env);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= AI_ENGINE_CONFIG.MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init = {
        method: 'POST',
        headers: {
          'Content-Type': CONTENT_TYPE_JSON,
          'x-correlation-id': getCorrelationId(),
          'x-capability-version': AI_ENGINE_CONFIG.CAPABILITY_VERSION,
        },
        body: stableStringify(payload),
        signal: controller.signal,
      };
      const response = await env.AI_ENGINE.fetch(url, init as any);
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`ai-engine HTTP ${response.status}: ${await response.text()}`);
      }

      const parsed = await response.json() as T;
      await clearFailures(env);
      return { ok: true, data: parsed };
    } catch (error) {
      clearTimeout(timer);
      lastError = error instanceof Error ? error : new Error(String(error));
      await recordFailure(env);
    }
  }

  return { ok: false, error: lastError?.message ?? 'Unknown ai-engine error' };
}

function signalSeverity(signals: unknown[]): string {
  for (const signal of signals) {
    if (typeof signal === 'object' && signal !== null && 'severity' in signal) {
      const severity = (signal as { severity?: unknown }).severity;
      if (typeof severity === 'string') return severity;
    }
  }
  return 'medium';
}

export function fallbackGrowthNextAction(input: GrowthNextActionRequest, error?: string): GrowthNextActionResult {
  const severity = signalSeverity(input.signals);
  const highIntent = severity === 'high' || severity === 'critical';
  const action: ProposedAgentAction = highIntent
    ? {
        type: AGENT_ACTION_TYPE.MANUAL_REVIEW,
        params: { reviewReason: 'high_intent_growth_signal', subjectId: input.subjectId },
        reason: 'High-intent signal requires deterministic operator review while ai-engine is unavailable.',
      }
    : {
        type: AGENT_ACTION_TYPE.WAIT,
        params: { reviewAfterSeconds: 24 * 60 * 60, subjectId: input.subjectId },
        reason: 'No safe autonomous action was available without ai-engine advice.',
      };

  return {
    action,
    riskLevel: highIntent ? AGENT_RISK_LEVEL.MEDIUM : AGENT_RISK_LEVEL.LOW,
    confidence: highIntent ? 60 : 55,
    explanation: action.reason ?? 'Deterministic fallback selected.',
    metadata: fallbackMetadata('growth-next-action', 0, error),
    rawSummary: { fallback: true, error: error ?? null, signalCount: input.signals.length },
  };
}

function normalizeGrowthNextActionResponse(
  input: GrowthNextActionRequest,
  response: Record<string, unknown>,
  latencyMs: number,
): GrowthNextActionResult {
  const actionRecord = typeof response.action === 'object' && response.action !== null
    ? response.action as Record<string, unknown>
    : {};
  const actionType = typeof actionRecord.type === 'string' ? actionRecord.type : AGENT_ACTION_TYPE.MANUAL_REVIEW;
  const params = typeof actionRecord.params === 'object' && actionRecord.params !== null && !Array.isArray(actionRecord.params)
    ? actionRecord.params as Record<string, unknown>
    : {};

  return {
    action: {
      type: actionType,
      params,
      reason: typeof actionRecord.reason === 'string' ? actionRecord.reason : undefined,
    },
    riskLevel: typeof response.riskLevel === 'string' ? response.riskLevel : AGENT_RISK_LEVEL.MEDIUM,
    confidence: typeof response.confidence === 'number' ? Math.max(0, Math.min(100, Math.floor(response.confidence))) : 60,
    explanation: typeof response.explanation === 'string' ? response.explanation : 'ai-engine returned a structured recommendation.',
    metadata: metadataFromResponse('growth-next-action', response, latencyMs),
    rawSummary: {
      tenantId: normalizeTenantId(input.tenantId),
      subjectId: input.subjectId,
      response,
    },
  };
}

export function createAiEngineClient(env: Env) {
  return {
    configured: Boolean(env.AI_ENGINE),
    async growthNextAction(input: GrowthNextActionRequest): Promise<GrowthNextActionResult> {
      const startedAt = Date.now();
      const result = await requestCapability<Record<string, unknown>>(env, 'growth-next-action', {
        tenantId: normalizeTenantId(input.tenantId),
        subjectId: input.subjectId,
        signals: input.signals,
        context: input.context,
        responseSchemaVersion: AI_ENGINE_CONFIG.RESPONSE_SCHEMA_VERSION,
      });
      const latencyMs = Date.now() - startedAt;
      if (!result.ok || !result.data) {
        const fallback = fallbackGrowthNextAction(input, result.error);
        return { ...fallback, metadata: { ...fallback.metadata, latencyMs } };
      }
      return normalizeGrowthNextActionResponse(input, result.data, latencyMs);
    },
    growthSignalSummarize: (payload: Record<string, unknown>) => requestCapability(env, 'growth-signal-summarize', payload),
    journeyCritic: (payload: Record<string, unknown>) => requestCapability(env, 'journey-critic', payload),
    messageBrief: (payload: Record<string, unknown>) => requestCapability(env, 'message-brief', payload),
    outcomeDiagnose: (payload: Record<string, unknown>) => requestCapability(env, 'outcome-diagnose', payload),
  };
}