import type {
  ActionType,
  CapabilityName,
  GrowthNextActionResponse,
  MessageBriefResponse,
  OutcomeDiagnoseResponse,
} from "../types";

type RiskLevel = "low" | "medium" | "high" | "critical";

export interface SemanticEvalThresholds {
  caseScoreMin: number;
  passRateMin: number;
  schemaValidityRateMin: number;
  fallbackRateMax: number;
}

export const DEFAULT_SEMANTIC_EVAL_THRESHOLDS: SemanticEvalThresholds = {
  caseScoreMin: 0.8,
  passRateMin: 1,
  schemaValidityRateMin: 1,
  fallbackRateMax: 0,
};

export interface SemanticCheckResult {
  name: string;
  passed: boolean;
  weight: number;
  detail: string;
}

export interface SemanticEvalResult {
  id: string;
  capability: CapabilityName;
  score: number;
  passed: boolean;
  failures: string[];
  checks: SemanticCheckResult[];
}

export interface SemanticEvalRunItem {
  result: SemanticEvalResult;
  schemaValid?: boolean;
  fallback?: boolean;
  latencyMs?: number;
  tokenEstimate?: number;
  costEstimate?: number;
}

export interface SemanticEvalSummary {
  total: number;
  passed: boolean;
  passedCases: number;
  failedCases: number;
  passRate: number;
  averageScore: number;
  schemaValidityRate: number;
  fallbackRate: number;
  avgLatencyMs: number | null;
  tokenEstimateTotal: number;
  costEstimateTotal: number;
  failures: string[];
  thresholds: SemanticEvalThresholds;
}

export interface GrowthNextActionExpectation {
  expectedActionTypes?: ActionType[];
  forbiddenActionTypes?: ActionType[];
  maxRiskLevel?: RiskLevel;
  minConfidence?: number;
  maxConfidence?: number;
  expectedSubjectId?: string;
  requiredTerms?: string[];
}

export interface MessageBriefExpectation {
  maxHeadlineChars?: number;
  maxCtaChars?: number;
  requiredTerms?: string[];
  forbiddenTerms?: string[];
  requiredGuardrailTerms?: string[];
}

export interface OutcomeDiagnoseExpectation {
  requiredCauseTerms?: string[];
  requiredExperimentTerms?: string[];
  minLikelyCauses?: number;
  minRecommendedExperiments?: number;
  forbiddenTerms?: string[];
}

interface CheckInput {
  name: string;
  passed: boolean;
  detail: string;
  weight?: number;
}

const RISK_RANK: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function containsAllTerms(text: string, terms: string[] | undefined): boolean {
  if (!terms || terms.length === 0) return true;
  const normalized = text.toLowerCase();
  return terms.every((term) => normalized.includes(term.toLowerCase()));
}

function containsNoTerms(text: string, terms: string[] | undefined): boolean {
  if (!terms || terms.length === 0) return true;
  const normalized = text.toLowerCase();
  return terms.every((term) => !normalized.includes(term.toLowerCase()));
}

function buildResult(
  id: string,
  capability: CapabilityName,
  checks: CheckInput[],
  thresholds: SemanticEvalThresholds = DEFAULT_SEMANTIC_EVAL_THRESHOLDS,
): SemanticEvalResult {
  const normalizedChecks = checks.map((check) => ({ ...check, weight: check.weight ?? 1 }));
  const totalWeight = normalizedChecks.reduce((sum, check) => sum + check.weight, 0);
  const earnedWeight = normalizedChecks.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0);
  const score = totalWeight > 0 ? earnedWeight / totalWeight : 1;
  const failures = normalizedChecks.filter((check) => !check.passed).map((check) => `${check.name}: ${check.detail}`);

  return {
    id,
    capability,
    score,
    passed: score >= thresholds.caseScoreMin && failures.length === 0,
    failures,
    checks: normalizedChecks,
  };
}

export function evaluateGrowthNextActionOutput(
  id: string,
  output: GrowthNextActionResponse,
  expected: GrowthNextActionExpectation,
  thresholds: SemanticEvalThresholds = DEFAULT_SEMANTIC_EVAL_THRESHOLDS,
): SemanticEvalResult {
  const explanationText = [output.action.reason, output.explanation, output.rawSummary].join(" ");
  const checks: CheckInput[] = [];

  if (expected.expectedActionTypes && expected.expectedActionTypes.length > 0) {
    checks.push({
      name: "expected_action_type",
      passed: expected.expectedActionTypes.includes(output.action.type),
      detail: `expected one of ${expected.expectedActionTypes.join(", ")}, got ${output.action.type}`,
      weight: 2,
    });
  }
  if (expected.forbiddenActionTypes && expected.forbiddenActionTypes.length > 0) {
    checks.push({
      name: "forbidden_action_type",
      passed: !expected.forbiddenActionTypes.includes(output.action.type),
      detail: `forbidden ${expected.forbiddenActionTypes.join(", ")}, got ${output.action.type}`,
      weight: 2,
    });
  }
  if (expected.maxRiskLevel) {
    checks.push({
      name: "risk_ceiling",
      passed: RISK_RANK[output.riskLevel] <= RISK_RANK[expected.maxRiskLevel],
      detail: `expected risk <= ${expected.maxRiskLevel}, got ${output.riskLevel}`,
    });
  }
  if (typeof expected.minConfidence === "number") {
    checks.push({
      name: "minimum_confidence",
      passed: output.confidence >= expected.minConfidence,
      detail: `expected confidence >= ${expected.minConfidence}, got ${output.confidence}`,
    });
  }
  if (typeof expected.maxConfidence === "number") {
    checks.push({
      name: "maximum_confidence",
      passed: output.confidence <= expected.maxConfidence,
      detail: `expected confidence <= ${expected.maxConfidence}, got ${output.confidence}`,
    });
  }
  if (expected.expectedSubjectId) {
    checks.push({
      name: "subject_specificity",
      passed: output.action.params.subjectId === expected.expectedSubjectId,
      detail: `expected params.subjectId=${expected.expectedSubjectId}, got ${String(output.action.params.subjectId)}`,
    });
  }
  if (expected.requiredTerms && expected.requiredTerms.length > 0) {
    checks.push({
      name: "required_reasoning_terms",
      passed: containsAllTerms(explanationText, expected.requiredTerms),
      detail: `missing one of required terms: ${expected.requiredTerms.join(", ")}`,
    });
  }

  return buildResult(id, "growth-next-action", checks, thresholds);
}

export function evaluateMessageBriefOutput(
  id: string,
  output: MessageBriefResponse,
  expected: MessageBriefExpectation,
  thresholds: SemanticEvalThresholds = DEFAULT_SEMANTIC_EVAL_THRESHOLDS,
): SemanticEvalResult {
  const messageText = [output.headline, output.coreMessage, output.tone, output.cta].join(" ");
  const fullText = [messageText, output.guardrails.join(" ")].join(" ");
  const checks: CheckInput[] = [];

  if (typeof expected.maxHeadlineChars === "number") {
    checks.push({
      name: "headline_length",
      passed: output.headline.length <= expected.maxHeadlineChars,
      detail: `expected headline <= ${expected.maxHeadlineChars}, got ${output.headline.length}`,
    });
  }
  if (typeof expected.maxCtaChars === "number") {
    checks.push({
      name: "cta_length",
      passed: output.cta.length <= expected.maxCtaChars,
      detail: `expected cta <= ${expected.maxCtaChars}, got ${output.cta.length}`,
    });
  }
  if (expected.requiredTerms && expected.requiredTerms.length > 0) {
    checks.push({
      name: "required_message_terms",
      passed: containsAllTerms(fullText, expected.requiredTerms),
      detail: `missing one of required terms: ${expected.requiredTerms.join(", ")}`,
      weight: 2,
    });
  }
  if (expected.forbiddenTerms && expected.forbiddenTerms.length > 0) {
    checks.push({
      name: "forbidden_message_terms",
      passed: containsNoTerms(messageText, expected.forbiddenTerms),
      detail: `found forbidden term from: ${expected.forbiddenTerms.join(", ")}`,
      weight: 2,
    });
  }
  if (expected.requiredGuardrailTerms && expected.requiredGuardrailTerms.length > 0) {
    checks.push({
      name: "required_guardrails",
      passed: containsAllTerms(output.guardrails.join(" "), expected.requiredGuardrailTerms),
      detail: `missing guardrail term from: ${expected.requiredGuardrailTerms.join(", ")}`,
    });
  }

  return buildResult(id, "message-brief", checks, thresholds);
}

export function evaluateOutcomeDiagnoseOutput(
  id: string,
  output: OutcomeDiagnoseResponse,
  expected: OutcomeDiagnoseExpectation,
  thresholds: SemanticEvalThresholds = DEFAULT_SEMANTIC_EVAL_THRESHOLDS,
): SemanticEvalResult {
  const causeText = [output.diagnosis, output.likelyCauses.join(" ")].join(" ");
  const experimentText = output.recommendedNextExperiments.join(" ");
  const fullText = [causeText, experimentText].join(" ");
  const checks: CheckInput[] = [];

  if (expected.requiredCauseTerms && expected.requiredCauseTerms.length > 0) {
    checks.push({
      name: "required_cause_terms",
      passed: containsAllTerms(causeText, expected.requiredCauseTerms),
      detail: `missing cause term from: ${expected.requiredCauseTerms.join(", ")}`,
      weight: 2,
    });
  }
  if (expected.requiredExperimentTerms && expected.requiredExperimentTerms.length > 0) {
    checks.push({
      name: "required_experiment_terms",
      passed: containsAllTerms(experimentText, expected.requiredExperimentTerms),
      detail: `missing experiment term from: ${expected.requiredExperimentTerms.join(", ")}`,
      weight: 2,
    });
  }
  if (typeof expected.minLikelyCauses === "number") {
    checks.push({
      name: "minimum_likely_causes",
      passed: output.likelyCauses.length >= expected.minLikelyCauses,
      detail: `expected at least ${expected.minLikelyCauses} likely causes, got ${output.likelyCauses.length}`,
    });
  }
  if (typeof expected.minRecommendedExperiments === "number") {
    checks.push({
      name: "minimum_recommended_experiments",
      passed: output.recommendedNextExperiments.length >= expected.minRecommendedExperiments,
      detail: `expected at least ${expected.minRecommendedExperiments} experiments, got ${output.recommendedNextExperiments.length}`,
    });
  }
  if (expected.forbiddenTerms && expected.forbiddenTerms.length > 0) {
    checks.push({
      name: "forbidden_diagnosis_terms",
      passed: containsNoTerms(fullText, expected.forbiddenTerms),
      detail: `found forbidden term from: ${expected.forbiddenTerms.join(", ")}`,
    });
  }

  return buildResult(id, "outcome-diagnose", checks, thresholds);
}

export function summarizeSemanticEvalRun(
  items: SemanticEvalRunItem[],
  thresholds: SemanticEvalThresholds = DEFAULT_SEMANTIC_EVAL_THRESHOLDS,
): SemanticEvalSummary {
  const total = items.length;
  const denominator = Math.max(1, total);
  const passedCases = items.filter((item) => item.result.passed).length;
  const failedCases = total - passedCases;
  const schemaValidCases = items.filter((item) => item.schemaValid !== false).length;
  const fallbackCases = items.filter((item) => item.fallback === true).length;
  const latencyValues = items
    .map((item) => item.latencyMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const tokenEstimateTotal = items.reduce((sum, item) => sum + (item.tokenEstimate ?? 0), 0);
  const costEstimateTotal = items.reduce((sum, item) => sum + (item.costEstimate ?? 0), 0);
  const passRate = passedCases / denominator;
  const schemaValidityRate = schemaValidCases / denominator;
  const fallbackRate = fallbackCases / denominator;
  const averageScore = items.reduce((sum, item) => sum + item.result.score, 0) / denominator;
  const avgLatencyMs = latencyValues.length > 0
    ? latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length
    : null;
  const failures = items.flatMap((item) => item.result.failures.map((failure) => `${item.result.id}: ${failure}`));

  return {
    total,
    passed:
      failedCases === 0 &&
      passRate >= thresholds.passRateMin &&
      schemaValidityRate >= thresholds.schemaValidityRateMin &&
      fallbackRate <= thresholds.fallbackRateMax,
    passedCases,
    failedCases,
    passRate,
    averageScore,
    schemaValidityRate,
    fallbackRate,
    avgLatencyMs,
    tokenEstimateTotal,
    costEstimateTotal,
    failures,
    thresholds,
  };
}