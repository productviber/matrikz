import { ACTION_TYPE_WHITELIST, SIGNAL_TYPE_ENUM } from "@clodo/growth-agent-contracts";

export const API_PREFIX = "/internal";

export const CAPABILITY_PATHS = {
  growthNextAction: "/internal/growth-next-action",
  growthSignalSummarize: "/internal/growth-signal-summarize",
  journeyCritic: "/internal/journey-critic",
  messageBrief: "/internal/message-brief",
  outcomeDiagnose: "/internal/outcome-diagnose",
} as const;

export const CAPABILITY_NAMES = {
  [CAPABILITY_PATHS.growthNextAction]: "growth-next-action",
  [CAPABILITY_PATHS.growthSignalSummarize]: "growth-signal-summarize",
  [CAPABILITY_PATHS.journeyCritic]: "journey-critic",
  [CAPABILITY_PATHS.messageBrief]: "message-brief",
  [CAPABILITY_PATHS.outcomeDiagnose]: "outcome-diagnose",
} as const;

export const KNOWN_ACTION_TYPES = ACTION_TYPE_WHITELIST;
export const KNOWN_SIGNAL_TYPES = SIGNAL_TYPE_ENUM;

export const DEFAULTS = {
  appVersion: "0.1.0",
  requestSchemaVersion: "1.0.0",
  responseSchemaVersion: "1.0.0",
  provider: "workers-ai",
  maxTokens: {
    "growth-next-action": 350,
    "growth-signal-summarize": 280,
    "journey-critic": 320,
    "message-brief": 260,
    "outcome-diagnose": 300,
  },
  timeoutMs: 3500,
  maxRetries: 1,
  outputRepairAttempts: 1,
  budgetPerTenantPerMinute: 120,
  rateLimitPerTenantCapabilityPerMinute: 180,
  secretRotationWindowHours: 24,
  retryAfterSeconds: 300,
} as const;

export const HEADER_NAMES = {
  internalSecret: "x-internal-secret",
  correlationId: "x-correlation-id",
  tenantId: "x-tenant-id",
  idempotencyKey: "x-idempotency-key",
  contentType: "content-type",
} as const;

export const ROUTE_REASONS = {
  predictive: "predictive",
  pinned: "pinned",
  tierDegraded: "tier_degraded",
  fallback: "fallback",
  rateLimited: "rate_limited",
} as const;

export const CAPABILITY_ENV_FLAGS = {
  "growth-next-action": "CAPABILITY_GROWTH_NEXT_ACTION_ENABLED",
  "growth-signal-summarize": "CAPABILITY_GROWTH_SIGNAL_SUMMARIZE_ENABLED",
  "journey-critic": "CAPABILITY_JOURNEY_CRITIC_ENABLED",
  "message-brief": "CAPABILITY_MESSAGE_BRIEF_ENABLED",
  "outcome-diagnose": "CAPABILITY_OUTCOME_DIAGNOSE_ENABLED",
} as const;

export const SLO_TARGETS = {
  latencyP99Ms: {
    warm: 800,
    cold: 3000,
  },
  maxNonDegraded5xxErrorRatePct: 0.5,
  maxFallbackRatePct: 15,
  rolloutGateWindowMinutes: 30,
} as const;

export const MODEL_COST_PER_1K_TOKENS_USD: Record<string, number> = {
  "@cf/meta/llama-3.1-8b-instruct": 0,
};
