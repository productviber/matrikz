import type { Env } from '../../types';
import { OUTCOME_DELTA_MAP } from '@clodo/growth-agent-contracts';
import { normalizeTenantId, stableStringify } from './common';
import {
  isUuidV4,
  markFeedbackIdempotentKeySeen,
  markOutcomeFeedbackFailure,
  markOutcomeFeedbackSuccess,
} from './closedLoop';

export { OUTCOME_DELTA_MAP };
export type OutcomeMetric = keyof typeof OUTCOME_DELTA_MAP;

export interface SendOutcomeFeedbackParams {
  correlationId: string;
  tenantId: string;
  subjectId: string;
  actionTaken: string;
  outcomeMetric: OutcomeMetric;
  observedAt: string;
  sourceEventType?: string;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_BACKOFF_MS = [120, 320] as const;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function buildUuidV4(): string {
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = crypto.randomUUID();
    if (UUID_V4.test(candidate) && isUuidV4(candidate)) {
      return candidate;
    }
  }
  return crypto.randomUUID();
}

function endpoint(env: Env): string {
  if (env.OUTCOME_FEEDBACK_URL && env.OUTCOME_FEEDBACK_URL.trim().length > 0) {
    return env.OUTCOME_FEEDBACK_URL.trim();
  }
  return 'https://matrikz/internal/outcome-feedback';
}

function transientError(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

async function waitMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendOutcomeFeedback(env: Env, params: SendOutcomeFeedbackParams): Promise<void> {
  const service = env.MATRIKZ ?? env.AI_ENGINE;
  const internalSecret = env.GROWTH_AGENT_INTERNAL_SECRET ?? env.INTERNAL_SECRET ?? env.INTERNAL_SECRET_ROLLOVER;
  if (!service || !internalSecret) {
    return;
  }

  const tenantId = normalizeTenantId(params.tenantId);
  const eventFingerprint = `${tenantId}:${params.correlationId}:${params.subjectId}:${params.actionTaken}:${params.outcomeMetric}:${params.observedAt}`;
  const firstDelivery = await markFeedbackIdempotentKeySeen(env, eventFingerprint);
  if (!firstDelivery) {
    return;
  }

  const idempotencyKey = buildUuidV4();
  const delta = OUTCOME_DELTA_MAP[params.outcomeMetric];
  const body = {
    correlationId: params.correlationId,
    tenantId,
    subjectId: params.subjectId,
    actionTaken: params.actionTaken,
    outcomeMetric: params.outcomeMetric,
    delta,
    observedAt: params.observedAt,
    sourceEventType: params.sourceEventType ?? null,
  };

  const startedAt = Date.now();

  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      const response = await service.fetch(endpoint(env), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-secret': internalSecret,
          'x-correlation-id': params.correlationId,
          'x-tenant-id': tenantId,
          'x-idempotency-key': idempotencyKey,
        },
        body: stableStringify(body),
      });

      if (response.ok || response.status === 409) {
        await markOutcomeFeedbackSuccess(env, tenantId, Date.now() - startedAt);
        return;
      }

      if (transientError(response.status) && attempt < RETRY_BACKOFF_MS.length) {
        await waitMs(RETRY_BACKOFF_MS[attempt]);
        continue;
      }

      await markOutcomeFeedbackFailure(env, tenantId);
      console.log(JSON.stringify({
        type: 'outcome_feedback_send_failed',
        status: response.status,
        correlationId: params.correlationId,
        tenantId,
        sourceEventType: params.sourceEventType ?? null,
      }));
      return;
    } catch (error) {
      if (attempt < RETRY_BACKOFF_MS.length) {
        await waitMs(RETRY_BACKOFF_MS[attempt]);
        continue;
      }
      await markOutcomeFeedbackFailure(env, tenantId);
      console.log(JSON.stringify({
        type: 'outcome_feedback_send_error',
        error: error instanceof Error ? error.message : 'unknown',
        correlationId: params.correlationId,
        tenantId,
        sourceEventType: params.sourceEventType ?? null,
      }));
      return;
    }
  }
}
