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
} from "@matrikz/growth-agent-contracts";
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
  INTERNAL_SECRET_PREVIOUS?: string;
  INTERNAL_SECRET_ROTATION_WINDOW_HOURS?: string;
  APP_VERSION?: string;
  RESPONSE_SCHEMA_VERSION?: string;
  REQUEST_SCHEMA_VERSION?: string;
  AI_MODEL?: string;
  AI_TIMEOUT_MS?: string;
  AI_MAX_RETRIES?: string;
  AI_OUTPUT_REPAIR_ATTEMPTS?: string;
  FEATURE_FLAGS_JSON?: string;
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
    featureFlags: {
      "growth-next-action": resolveCapabilityEnabled(
        env,
        "growth-next-action",
        parsedFlags["growth-next-action"],
      ),
      "growth-signal-summarize": resolveCapabilityEnabled(
        env,
        "growth-signal-summarize",
        parsedFlags["growth-signal-summarize"],
      ),
      "journey-critic": resolveCapabilityEnabled(env, "journey-critic", parsedFlags["journey-critic"]),
      "message-brief": resolveCapabilityEnabled(env, "message-brief", parsedFlags["message-brief"]),
      "outcome-diagnose": resolveCapabilityEnabled(
        env,
        "outcome-diagnose",
        parsedFlags["outcome-diagnose"],
      ),
    },
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

function toInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseFeatureFlags(raw: string | undefined): Partial<Record<CapabilityName, boolean>> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      "growth-next-action": toBool(parsed["growth-next-action"]),
      "growth-signal-summarize": toBool(parsed["growth-signal-summarize"]),
      "journey-critic": toBool(parsed["journey-critic"]),
      "message-brief": toBool(parsed["message-brief"]),
      "outcome-diagnose": toBool(parsed["outcome-diagnose"]),
    };
  } catch {
    return {};
  }
}

function toBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}
