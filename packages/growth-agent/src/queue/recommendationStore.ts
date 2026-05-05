import type { PendingRecommendation, GrowthAgentEnv } from "../types";

export async function recommendationExists(
  env: GrowthAgentEnv,
  tenantId: string,
  subjectId: string,
  nowIso: string,
): Promise<boolean> {
  if (!env.OUTCOME_DB) {
    return false;
  }
  const row = await env.OUTCOME_DB.prepare(
    `SELECT id FROM recommendation_log
     WHERE tenant_id = ?1 AND subject_id = ?2 AND expires_at > ?3
     LIMIT 1`,
  )
    .bind(tenantId, subjectId, nowIso)
    .first<{ id: string }>();

  return Boolean(row?.id);
}

export async function saveRecommendation(
  env: GrowthAgentEnv,
  recommendation: PendingRecommendation,
  source: "reactive" | "proactive",
): Promise<void> {
  if (!env.OUTCOME_DB) {
    return;
  }
  await env.OUTCOME_DB.prepare(
    `INSERT OR IGNORE INTO recommendation_log
     (id, correlation_id, tenant_id, subject_id, capability, action_type,
      confidence, risk_level, enqueued_at, expires_at, source, experiment_id, arm)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  )
    .bind(
      crypto.randomUUID(),
      recommendation.correlationId,
      recommendation.tenantId,
      recommendation.subjectId,
      recommendation.capability,
      recommendation.action.type,
      recommendation.confidence,
      recommendation.riskLevel,
      recommendation.enqueuedAt,
      recommendation.expiresAt,
      source,
      recommendation.experimentId ?? null,
      recommendation.arm ?? null,
    )
    .run();
}

export async function markRecommendationDispatched(
  env: GrowthAgentEnv,
  correlationId: string,
): Promise<void> {
  if (!env.OUTCOME_DB) {
    return;
  }
  await env.OUTCOME_DB.prepare(
    `UPDATE recommendation_log SET dispatched_at = ?1 WHERE correlation_id = ?2`,
  )
    .bind(new Date().toISOString(), correlationId)
    .run();
}

export interface RecommendationRow {
  confidence: number;
  capability: string;
  actionType: string;
  experimentId: string | null;
  arm: string | null;
}

export async function findRecommendationByCorrelation(
  env: GrowthAgentEnv,
  correlationId: string,
): Promise<RecommendationRow | null> {
  if (!env.OUTCOME_DB) {
    return null;
  }
  const row = await env.OUTCOME_DB.prepare(
    `SELECT confidence, capability, action_type as actionType,
            experiment_id as experimentId, arm
     FROM recommendation_log
     WHERE correlation_id = ?1
     LIMIT 1`,
  )
    .bind(correlationId)
    .first<RecommendationRow>();

  return row ?? null;
}