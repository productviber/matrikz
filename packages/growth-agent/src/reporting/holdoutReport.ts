import type { GrowthAgentEnv } from "../types";

export interface HoldoutReportOptions {
  windowDays: number;
  experimentId?: string | null;
  actionType?: string | null;
  minArmSample?: number;
}

export interface HoldoutArmStats {
  arm: string;
  recommendations: number;
  outcomes: number;
  positiveOutcomes: number;
  conversions: number;
  totalDelta: number;
  outcomeRate: number;
  positiveOutcomeRate: number;
  conversionRate: number;
  avgDeltaPerRecommendation: number;
  avgObservedDelta: number | null;
}

export interface HoldoutComparison {
  experimentId: string;
  capability: string;
  actionType: string;
  arms: HoldoutArmStats[];
  treatment: HoldoutArmStats | null;
  control: HoldoutArmStats | null;
  uplift: {
    positiveOutcomeRate: number | null;
    conversionRate: number | null;
    avgDeltaPerRecommendation: number | null;
    positiveOutcomeRateConfidenceInterval95: {
      lower: number;
      upper: number;
      standardError: number;
    } | null;
    sampleSizeSufficient: boolean;
  };
}

export interface HoldoutReport {
  available: boolean;
  reason: string | null;
  windowDays: number;
  sinceIso: string;
  minArmSample: number;
  scope: {
    experimentId: string | null;
    actionType: string | null;
  };
  comparisons: HoldoutComparison[];
}

interface HoldoutRow {
  experimentId: string | null;
  arm: string | null;
  capability: string;
  actionType: string;
  recommendations: number;
  outcomes: number | null;
  positiveOutcomes: number | null;
  conversions: number | null;
  totalDelta: number | null;
  avgObservedDelta: number | null;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toArmStats(row: HoldoutRow): HoldoutArmStats {
  const recommendations = asNumber(row.recommendations);
  const outcomes = asNumber(row.outcomes);
  const positiveOutcomes = asNumber(row.positiveOutcomes);
  const conversions = asNumber(row.conversions);
  const totalDelta = asNumber(row.totalDelta);
  return {
    arm: row.arm ?? "unassigned",
    recommendations,
    outcomes,
    positiveOutcomes,
    conversions,
    totalDelta,
    outcomeRate: rate(outcomes, recommendations),
    positiveOutcomeRate: rate(positiveOutcomes, recommendations),
    conversionRate: rate(conversions, recommendations),
    avgDeltaPerRecommendation: rate(totalDelta, recommendations),
    avgObservedDelta: row.avgObservedDelta ?? null,
  };
}

function confidenceIntervalForRateDifference(
  treatment: HoldoutArmStats,
  control: HoldoutArmStats,
): { lower: number; upper: number; standardError: number } | null {
  if (treatment.recommendations <= 0 || control.recommendations <= 0) return null;
  const treatmentRate = treatment.positiveOutcomeRate;
  const controlRate = control.positiveOutcomeRate;
  const standardError = Math.sqrt(
    (treatmentRate * (1 - treatmentRate)) / treatment.recommendations +
    (controlRate * (1 - controlRate)) / control.recommendations,
  );
  const diff = treatmentRate - controlRate;
  const margin = 1.96 * standardError;
  return {
    lower: diff - margin,
    upper: diff + margin,
    standardError,
  };
}

export async function buildHoldoutReport(
  env: GrowthAgentEnv,
  options: HoldoutReportOptions,
): Promise<HoldoutReport> {
  const windowDays = Math.max(1, Math.min(options.windowDays, 365));
  const minArmSample = Math.max(1, Math.floor(options.minArmSample ?? 50));
  const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const baseReport = {
    windowDays,
    sinceIso,
    minArmSample,
    scope: {
      experimentId: options.experimentId ?? null,
      actionType: options.actionType ?? null,
    },
  };

  if (!env.OUTCOME_DB) {
    return { available: false, reason: "outcome_db_unavailable", ...baseReport, comparisons: [] };
  }

  const where = ["r.enqueued_at >= ?1", "r.experiment_id IS NOT NULL"];
  const params: unknown[] = [sinceIso];
  if (options.experimentId) {
    params.push(options.experimentId);
    where.push(`r.experiment_id = ?${params.length}`);
  }
  if (options.actionType) {
    params.push(options.actionType);
    where.push(`r.action_type = ?${params.length}`);
  }

  let rows: HoldoutRow[];
  try {
    const result = await env.OUTCOME_DB.prepare(
      `SELECT r.experiment_id AS experimentId,
              COALESCE(r.arm, 'unassigned') AS arm,
              r.capability AS capability,
              r.action_type AS actionType,
              COUNT(DISTINCT r.correlation_id) AS recommendations,
              COUNT(DISTINCT o.id) AS outcomes,
              SUM(CASE WHEN o.delta > 0 THEN 1 ELSE 0 END) AS positiveOutcomes,
              SUM(CASE WHEN lower(o.outcome_metric) IN ('conversion', 'converted') OR o.delta >= 1 THEN 1 ELSE 0 END) AS conversions,
              SUM(COALESCE(o.delta, 0)) AS totalDelta,
              AVG(CASE WHEN o.id IS NOT NULL THEN o.delta ELSE NULL END) AS avgObservedDelta
         FROM recommendation_log r
    LEFT JOIN outcome_records o ON o.correlation_id = r.correlation_id
        WHERE ${where.join(" AND ")}
        GROUP BY r.experiment_id, COALESCE(r.arm, 'unassigned'), r.capability, r.action_type
        ORDER BY r.experiment_id ASC, r.action_type ASC, arm ASC`,
    )
      .bind(...params)
      .all<HoldoutRow>();
    rows = result.results ?? [];
  } catch {
    return { available: false, reason: "holdout_columns_unavailable", ...baseReport, comparisons: [] };
  }

  const grouped = new Map<string, HoldoutArmStats[]>();
  for (const row of rows) {
    if (!row.experimentId) continue;
    const key = `${row.experimentId}\u0000${row.capability}\u0000${row.actionType}`;
    const current = grouped.get(key) ?? [];
    current.push(toArmStats(row));
    grouped.set(key, current);
  }

  const comparisons: HoldoutComparison[] = [...grouped.entries()].map(([key, arms]) => {
    const [experimentId, capability, actionType] = key.split("\u0000");
    const treatment = arms.find((arm) => arm.arm === "treatment") ?? null;
    const control = arms.find((arm) => arm.arm === "control") ?? null;
    const sampleSizeSufficient = Boolean(
      treatment && control && treatment.recommendations >= minArmSample && control.recommendations >= minArmSample,
    );
    return {
      experimentId,
      capability,
      actionType,
      arms,
      treatment,
      control,
      uplift: {
        positiveOutcomeRate: treatment && control ? treatment.positiveOutcomeRate - control.positiveOutcomeRate : null,
        conversionRate: treatment && control ? treatment.conversionRate - control.conversionRate : null,
        avgDeltaPerRecommendation: treatment && control
          ? treatment.avgDeltaPerRecommendation - control.avgDeltaPerRecommendation
          : null,
        positiveOutcomeRateConfidenceInterval95: sampleSizeSufficient && treatment && control
          ? confidenceIntervalForRateDifference(treatment, control)
          : null,
        sampleSizeSufficient,
      },
    };
  });

  return { available: true, reason: null, ...baseReport, comparisons };
}