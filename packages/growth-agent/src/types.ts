import {
  type CapabilityEnvelope,
  type CapabilityName,
  type ErrorCode,
  type GrowthNextActionRequest,
  type GrowthNextActionResponse,
  type GrowthSignal,
  type GrowthSignalSummarizeRequest,
  type GrowthSignalSummarizeResponse,
  type JourneyCriticRequest,
  type JourneyCriticResponse,
  type MessageBriefRequest,
  type MessageBriefResponse,
  type OutcomeDiagnoseRequest,
  type OutcomeDiagnoseResponse,
  type Metadata,
  type ActionType,
  type TenantPrior,
  type TenantSubject,
  type PendingRecommendation,
  type OutcomeFeedbackRequest,
  type OutcomeFeedbackResponse,
} from "@clodo/growth-agent-contracts";
import { CAPABILITY_ENV_FLAGS, DEFAULTS, ROUTE_REASONS } from "./constants";

export type {
  CapabilityEnvelope,
  CapabilityName,
  ErrorCode,
  GrowthNextActionRequest,
  GrowthNextActionResponse,
  GrowthSignal,
  GrowthSignalSummarizeRequest,
  GrowthSignalSummarizeResponse,
  JourneyCriticRequest,
  JourneyCriticResponse,
  MessageBriefRequest,
  MessageBriefResponse,
  OutcomeDiagnoseRequest,
  OutcomeDiagnoseResponse,
  Metadata,
  ActionType,
  TenantPrior,
  TenantSubject,
  PendingRecommendation,
  OutcomeFeedbackRequest,
  OutcomeFeedbackResponse,
};

export type RouteReason = (typeof ROUTE_REASONS)[keyof typeof ROUTE_REASONS];

export interface GrowthAgentEnv {
  INTERNAL_SECRET?: string;
  INTERNAL_SECRET_PREVIOUS?: string;
  INTERNAL_SECRET_ROTATION_WINDOW_HOURS?: string;
  APP_VERSION?: string;
  ENVIRONMENT?: string;
  RESPONSE_SCHEMA_VERSION?: string;
  REQUEST_SCHEMA_VERSION?: string;
  AI_MODEL?: string;
  AI_TIMEOUT_MS?: string;
  AI_MAX_RETRIES?: string;
  AI_OUTPUT_REPAIR_ATTEMPTS?: string;
  SECONDARY_LLM_PROVIDER_URL?: string;
  SECONDARY_LLM_PROVIDER_API_KEY?: string;
  BUDGET_PER_TENANT_PER_MIN?: string;
  RATE_LIMIT_PER_TENANT_CAPABILITY_PER_MIN?: string;
  CAPABILITY_GROWTH_NEXT_ACTION_ENABLED?: string;
  CAPABILITY_GROWTH_SIGNAL_SUMMARIZE_ENABLED?: string;
  CAPABILITY_JOURNEY_CRITIC_ENABLED?: string;
  CAPABILITY_MESSAGE_BRIEF_ENABLED?: string;
  CAPABILITY_OUTCOME_DIAGNOSE_ENABLED?: string;
  CAPABILITY_OUTCOME_FEEDBACK_ENABLED?: string;
  CAPABILITY_PROACTIVE_SCAN_ENABLED?: string;
  PROACTIVE_SCAN_ENABLED?: string;
  PROACTIVE_SCAN_COOLDOWN_HOURS?: string;
  PRIOR_TTL_DAYS?: string;
  CALIBRATION_RECALC_AFTER_N?: string;
  OUTCOME_RETENTION_DAYS?: string;
  PRIOR_AUDIT_SAMPLE_RATE?: string;
    PROACTIVE_SCAN_BATCH_SIZE?: string;
    MAX_PENDING_PER_TENANT?: string;
  WORKERS_AI?: {
    run(model: string, input: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  };
  TENANT_PRIOR_KV?: KVNamespace;
  TENANT_REGISTRY_KV?: KVNamespace;
  OUTCOME_DB?: D1Database;
  RECOMMENDATION_QUEUE?: Queue<PendingRecommendation>;
}

export interface RequestContext {
  correlationId: string;
  tenantId: string;
  idempotencyKeyPresent: boolean;
  startedAt: number;
}

export interface LlmGenerateArgs {
  capability: CapabilityName;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  totalDeadlineMs?: number;
  maxRetries: number;
  outputRepairAttempts: number;
  systemPrompt: string;
  userPrompt: string;
  temperatureOverride?: number;
}

export interface LlmGenerateResult {
  rawText: string;
  tokenEstimate: number;
  model: string;
  provider: string;
}

export interface LlmAdapter {
  generateJson<T>(
    args: LlmGenerateArgs,
    validate: (value: unknown) => value is T,
  ): Promise<{ parsed: T; llm: LlmGenerateResult }>;
}

export interface TenantBudgetGuard {
  consume(tenantId: string, capability: CapabilityName): { allowed: boolean; remaining: number };
}

export interface TenantRateLimitGuard {
  consume(tenantId: string, capability: CapabilityName): { allowed: boolean; remaining: number };
}

export interface RuntimeConfig {
  appVersion: string;
  requestSchemaVersion: string;
  responseSchemaVersion: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  outputRepairAttempts: number;
  budgetPerTenantPerMinute: number;
  rateLimitPerTenantCapabilityPerMinute: number;
  secretRotationWindowHours: number;
  proactiveScanEnabled: boolean;
  proactiveScanCooldownHours: number;
  priorTtlDays: number;
  calibrationRecalcAfterN: number;
  outcomeRetentionDays: number;
  auditSampleRate: number;
    proactiveScanBatchSize: number;
    maxPendingPerTenant: number;
  featureFlags: Record<CapabilityName, boolean>;
}

export function getRuntimeConfig(env: GrowthAgentEnv): RuntimeConfig {
  const parsedFlags = parseFeatureFlags(env.FEATURE_FLAGS_JSON);

  return {
    appVersion: env.APP_VERSION ?? DEFAULTS.appVersion,
    requestSchemaVersion: env.REQUEST_SCHEMA_VERSION ?? DEFAULTS.requestSchemaVersion,
    responseSchemaVersion: env.RESPONSE_SCHEMA_VERSION ?? DEFAULTS.responseSchemaVersion,
    model: env.AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct",
    timeoutMs: toInt(env.AI_TIMEOUT_MS, DEFAULTS.timeoutMs),
    maxRetries: toInt(env.AI_MAX_RETRIES, DEFAULTS.maxRetries),
    outputRepairAttempts: toInt(env.AI_OUTPUT_REPAIR_ATTEMPTS, DEFAULTS.outputRepairAttempts),
    budgetPerTenantPerMinute: toInt(
      env.BUDGET_PER_TENANT_PER_MIN,
      DEFAULTS.budgetPerTenantPerMinute,
    ),
    rateLimitPerTenantCapabilityPerMinute: toInt(
      env.RATE_LIMIT_PER_TENANT_CAPABILITY_PER_MIN,
      DEFAULTS.rateLimitPerTenantCapabilityPerMinute,
    ),
    secretRotationWindowHours: toInt(
      env.INTERNAL_SECRET_ROTATION_WINDOW_HOURS,
      DEFAULTS.secretRotationWindowHours,
    ),
    proactiveScanEnabled:
      (env.PROACTIVE_SCAN_ENABLED ?? env.CAPABILITY_PROACTIVE_SCAN_ENABLED ?? "false").toLowerCase() === "true",
    proactiveScanCooldownHours: parsePositiveInt(env.PROACTIVE_SCAN_COOLDOWN_HOURS, DEFAULTS.proactiveScanCooldownHours),
    priorTtlDays: parsePositiveInt(env.PRIOR_TTL_DAYS, DEFAULTS.priorTtlDays),
    calibrationRecalcAfterN: parsePositiveInt(env.CALIBRATION_RECALC_AFTER_N, DEFAULTS.calibrationRecalcAfterN),
    outcomeRetentionDays: parsePositiveInt(env.OUTCOME_RETENTION_DAYS, DEFAULTS.outcomeRetentionDays),
    auditSampleRate: parseFloat01(env.PRIOR_AUDIT_SAMPLE_RATE, DEFAULTS.priorAuditSampleRate),
      proactiveScanBatchSize: parsePositiveInt(env.PROACTIVE_SCAN_BATCH_SIZE, DEFAULTS.proactiveScanBatchSize),
      maxPendingPerTenant: parsePositiveInt(env.MAX_PENDING_PER_TENANT, DEFAULTS.maxPendingPerTenant),
    featureFlags: parsedFlags,
  };
}

function resolveCapabilityEnabled(
  env: GrowthAgentEnv,
  capability: CapabilityName,
  fallbackFlag: boolean | undefined,
): boolean {
  const envName = CAPABILITY_ENV_FLAGS[capability];
  const raw = env[envName];
  if (typeof raw === "string") {
    return raw.toLowerCase() === "true";
  }
  return fallbackFlag ?? false;
}

function parseFloat01(value: string | undefined, fallback: number): number {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

function parseFeatureFlags(env: GrowthAgentEnv): Record<CapabilityName, boolean> {
  return {
    "growth-next-action": env[CAPABILITY_ENV_FLAGS["growth-next-action"]] === "true",
    "growth-signal-summarize": env[CAPABILITY_ENV_FLAGS["growth-signal-summarize"]] === "true",
    "journey-critic": env[CAPABILITY_ENV_FLAGS["journey-critic"]] === "true",
    "message-brief": env[CAPABILITY_ENV_FLAGS["message-brief"]] === "true",
    "outcome-diagnose": env[CAPABILITY_ENV_FLAGS["outcome-diagnose"]] === "true",
  };
}