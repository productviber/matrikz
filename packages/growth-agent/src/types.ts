import {
  type CapabilityEnvelope,
  type CapabilityName,
  type ErrorCode,
  type GrowthNextActionRequest,
  type GrowthNextActionResponse,
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
} from "@clodo/growth-agent-contracts";
import { CAPABILITY_ENV_FLAGS, DEFAULTS, ROUTE_REASONS } from "./constants";

export type {
  CapabilityEnvelope,
  CapabilityName,
  ErrorCode,
  GrowthNextActionRequest,
  GrowthNextActionResponse,
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
};

export type RouteReason = (typeof ROUTE_REASONS)[keyof typeof ROUTE_REASONS];

export interface GrowthAgentEnv {
  INTERNAL_SECRET?: string;
  /** Optional rollover secret — accepted in parallel during the rotation window. */
  INTERNAL_SECRET_ROLLOVER?: string;
  INTERNAL_SECRET_ROTATION_WINDOW_HOURS?: string;
  APP_VERSION?: string;
  RESPONSE_SCHEMA_VERSION?: string;
  REQUEST_SCHEMA_VERSION?: string;
  AI_MODEL?: string;
  AI_TIMEOUT_MS?: string;
  AI_MAX_RETRIES?: string;
  AI_OUTPUT_REPAIR_ATTEMPTS?: string;
  BUDGET_PER_TENANT_PER_MIN?: string;
  RATE_LIMIT_PER_TENANT_CAPABILITY_PER_MIN?: string;
  CAPABILITY_GROWTH_NEXT_ACTION_ENABLED?: string;
  CAPABILITY_GROWTH_SIGNAL_SUMMARIZE_ENABLED?: string;
  CAPABILITY_JOURNEY_CRITIC_ENABLED?: string;
  CAPABILITY_MESSAGE_BRIEF_ENABLED?: string;
  CAPABILITY_OUTCOME_DIAGNOSE_ENABLED?: string;
  WORKERS_AI?: {
    run(model: string, input: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  };
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
  maxRetries: number;
  outputRepairAttempts: number;
  systemPrompt: string;
  userPrompt: string;
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
  featureFlags: Record<CapabilityName, boolean>;
}

export function getRuntimeConfig(env: GrowthAgentEnv): RuntimeConfig {
  const parsedFlags = parseFeatureFlags(env);
  return {
    appVersion: env.APP_VERSION ?? DEFAULTS.appVersion,
    requestSchemaVersion: env.REQUEST_SCHEMA_VERSION ?? DEFAULTS.requestSchemaVersion,
    responseSchemaVersion: env.RESPONSE_SCHEMA_VERSION ?? DEFAULTS.responseSchemaVersion,
    model: env.AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct",
    timeoutMs: parsePositiveInt(env.AI_TIMEOUT_MS, DEFAULTS.timeoutMs),
    maxRetries: parsePositiveInt(env.AI_MAX_RETRIES, DEFAULTS.maxRetries),
    outputRepairAttempts: parsePositiveInt(env.AI_OUTPUT_REPAIR_ATTEMPTS, DEFAULTS.outputRepairAttempts),
    budgetPerTenantPerMinute: parsePositiveInt(env.BUDGET_PER_TENANT_PER_MIN, DEFAULTS.budgetPerTenantPerMinute),
    rateLimitPerTenantCapabilityPerMinute: parsePositiveInt(
      env.RATE_LIMIT_PER_TENANT_CAPABILITY_PER_MIN,
      DEFAULTS.rateLimitPerTenantCapabilityPerMinute,
    ),
    secretRotationWindowHours: parsePositiveInt(
      env.INTERNAL_SECRET_ROTATION_WINDOW_HOURS,
      DEFAULTS.secretRotationWindowHours,
    ),
    featureFlags: parsedFlags,
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
