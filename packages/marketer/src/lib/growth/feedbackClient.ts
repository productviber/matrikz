import type { Env } from '../../types';
import { OUTCOME_DELTA_MAP } from '@clodo/growth-agent-contracts';
import { normalizeTenantId } from './common';

export { OUTCOME_DELTA_MAP };
export type OutcomeMetric = keyof typeof OUTCOME_DELTA_MAP;

export interface SendOutcomeFeedbackParams {
  correlationId: string;
  tenantId: string;
  subjectId: string;
  actionTaken: string;
  outcomeMetric: OutcomeMetric;
  observedAt: string;
}

export async function sendOutcomeFeedback(env: Env, params: SendOutcomeFeedbackParams): Promise<void> {
  if (!env.AI_ENGINE || !env.INTERNAL_SECRET) {
    return;
  }
  try {
    const delta = OUTCOME_DELTA_MAP[params.outcomeMetric];
    const body = {
      correlationId: params.correlationId,
      tenantId: params.tenantId,
      subjectId: params.subjectId,
      actionTaken: params.actionTaken,
      outcomeMetric: params.outcomeMetric,
      delta,
      observedAt: params.observedAt,
    };
    const tenantId = normalizeTenantId(params.tenantId);
    const response = await env.AI_ENGINE.fetch('https://growth-agent/internal/outcome-feedback', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': env.INTERNAL_SECRET,
        'x-correlation-id': `${tenantId}:${crypto.randomUUID()}`,
        'x-tenant-id': tenantId,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.log(JSON.stringify({
        type: 'outcome_feedback_send_failed',
        status: response.status,
        correlationId: params.correlationId,
      }));
    }
  } catch (error) {
    console.log(JSON.stringify({
      type: 'outcome_feedback_send_error',
      error: error instanceof Error ? error.message : 'unknown',
      correlationId: params.correlationId,
    }));
  }
}
