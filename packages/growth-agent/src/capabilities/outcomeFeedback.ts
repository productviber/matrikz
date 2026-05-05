import {
  OutcomeFeedbackRequestSchema,
  type OutcomeFeedbackResponse,
  type TenantPrior,
} from "@clodo/growth-agent-contracts";
import { AppError } from "../errors";
import type { GrowthAgentEnv, OutcomeFeedbackRequest, RuntimeConfig } from "../types";
import { getTenantPrior, putTenantPrior } from "../priors/tenantPriorStore";
import { accumulatePrior } from "../priors/priorAccumulator";
import { updateStrategyWeights } from "../priors/strategyWeightUpdater";
import { findRecommendationByCorrelation } from "../queue/recommendationStore";

export async function handleOutcomeFeedback(
  input: unknown,
  env: GrowthAgentEnv,
  config: RuntimeConfig,
): Promise<OutcomeFeedbackResponse> {
  const parsed = OutcomeFeedbackRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "Invalid outcome feedback payload");
  }

  const payload = parsed.data;

  const existingRecommendation = await findRecommendationByCorrelation(env, payload.correlationId);
  if (!existingRecommendation) {
    throw new AppError("CORRELATION_NOT_FOUND", "Unknown correlationId");
  }

  const duplicate = await isDuplicateOutcome(env, payload.correlationId);
  if (duplicate) {
    throw new AppError("DUPLICATE_OUTCOME", "Outcome already recorded");
  }

  await insertOutcomeRecord(env, payload, existingRecommendation.capability, existingRecommendation.experimentId, existingRecommendation.arm);

  const prior = await getTenantPrior(env, payload.tenantId);
  const calibrationHistory = await readCalibrationHistory(env, payload.tenantId, config.calibrationRecalcAfterN);

  const nextPrior = accumulatePrior({
    prior,
    confidence: existingRecommendation.confidence,
    outcomeDelta: payload.delta,
    observedTone: inferTone(payload.actionTaken),
    calibrationHistory,
  });

  const driftedPrior = updateStrategyWeights(nextPrior, {
    outcomeDelta: payload.delta,
    fallbackTriggered: false,
    observedTone: inferTone(payload.actionTaken),
  });

  await putTenantPrior(env, payload.tenantId, driftedPrior, config.priorTtlDays, "outcome_feedback", config.auditSampleRate);


  void decrementQueueDepth(env, payload.tenantId);

  console.log(
    JSON.stringify({
      type: "outcome_feedback_received",
      correlationId: payload.correlationId,
      tenantId: payload.tenantId,
      capability: existingRecommendation.capability,
      delta: payload.delta,
      priorUpdated: true,
    }),
  );

  return {
    priorUpdated: true,
    calibrationDelta: driftedPrior.calibrationFactor - (prior?.calibrationFactor ?? 1),
  };
}

async function isDuplicateOutcome(env: GrowthAgentEnv, correlationId: string): Promise<boolean> {
  if (!env.OUTCOME_DB) {
    return false;
  }
  const row = await env.OUTCOME_DB.prepare(
    `SELECT id FROM outcome_records WHERE correlation_id = ?1 LIMIT 1`,
  )
    .bind(correlationId)
    .first<{ id: string }>();

  return Boolean(row?.id);
}

async function insertOutcomeRecord(
  env: GrowthAgentEnv,
  payload: OutcomeFeedbackRequest,
  capability: string,
    experimentId: string | null = null,
    arm: string | null = null,
): Promise<void> {
  if (!env.OUTCOME_DB) {
    return;
  }

  await env.OUTCOME_DB.prepare(
      `INSERT INTO outcome_records
       (id, correlation_id, tenant_id, subject_id, capability, action_type, outcome_metric, delta, observed_at, created_at, experiment_id, arm)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  )
    .bind(
      crypto.randomUUID(),
      payload.correlationId,
      payload.tenantId,
      payload.subjectId,
      capability,
      payload.actionTaken,
      payload.outcomeMetric,
      payload.delta,
      payload.observedAt,
      new Date().toISOString(),
        experimentId,
        arm,
    )
    .run();
}

async function readCalibrationHistory(
  env: GrowthAgentEnv,
  tenantId: string,
  maxRows: number,
): Promise<Array<{ predictedConfidence: number; observedDelta: number }>> {
  if (!env.OUTCOME_DB) {
    return [];
  }

  const rows = await env.OUTCOME_DB.prepare(
    `SELECT r.confidence as predictedConfidence, o.delta as observedDelta
     FROM recommendation_log r
     JOIN outcome_records o ON r.correlation_id = o.correlation_id
     WHERE r.tenant_id = ?1
     ORDER BY o.created_at DESC
     LIMIT ?2`,
  )
    .bind(tenantId, maxRows)
    .all<{ predictedConfidence: number; observedDelta: number }>();

  return rows.results ?? [];
}

function inferTone(actionTaken: string): string {
  if (actionTaken.toLowerCase().includes("urgent")) {
    return "urgent";
  }
  if (actionTaken.toLowerCase().includes("friendly")) {
    return "friendly";
  }
  return "clear";
}

async function decrementQueueDepth(env: GrowthAgentEnv, tenantId: string): Promise<void> {
  if (!env.TENANT_REGISTRY_KV) return;
  const depthKey = `queue-depth:${tenantId}`;
  const raw = await env.TENANT_REGISTRY_KV.get(depthKey);
  const current = Number.parseInt(raw ?? "0", 10);
  const next = Math.max(0, (Number.isFinite(current) ? current : 0) - 1);
  if (next > 0) {
    await env.TENANT_REGISTRY_KV.put(depthKey, String(next), { expirationTtl: 90000 });
  } else {
    await env.TENANT_REGISTRY_KV.delete(depthKey);
  }
}
