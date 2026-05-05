import { z } from "zod";

export const CAPABILITY_NAMES = [
  "growth-next-action",
  "growth-signal-summarize",
  "journey-critic",
  "message-brief",
  "outcome-diagnose",
] as const;

// Tier-1 intent vocabulary — what the agent decides.
// Channel resolution (Tier 2) is handled by the dispatcher via ChannelPolicy.
// Previously matched AGENT_ACTION_TYPE in packages/marketer/src/constants.ts;
// the dispatcher now translates intent → channel before forwarding to the marketer.
export const ACTION_TYPE_WHITELIST = [
  "nurture",   // early lifecycle, low intensity — inform/educate
  "activate",  // warm/ready, medium intensity — invite/prompt
  "convert",   // high-readiness, high intensity — offer/push
  "recover",   // at-risk/drifting, targeted — win-back/re-engage
  "pause",     // overloaded/fatigued — apply fatigue guard
  "escalate",  // stuck/needs human — hand off
  "wait",      // insufficient signal — no action yet
] as const;

export const ERROR_CODES = [
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_FAILURE",
  "UPSTREAM_QUOTA_EXCEEDED",
  "BUDGET_EXHAUSTED",
  "OUTPUT_SCHEMA_INVALID",
  "CAPABILITY_DISABLED",
  "RATE_LIMITED",
  "CORRELATION_NOT_FOUND",
  "DUPLICATE_OUTCOME",
  "INTERNAL_FALLBACK",
  "INTERNAL_ERROR",
] as const;

export const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
export const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const SIGNAL_TYPE_ENUM = [
  "intent",
  "engagement",
  "churn_risk",
  "lifecycle_stage",
  "revenue",
  "activity",
] as const;

/**
 * Canonical outcome delta values for the feedback loop.
 * Callers MUST use these constants — never inline floats.
 * Used by the marketer to call /internal/outcome-feedback after observing an event.
 */
export const OUTCOME_DELTA_MAP = {
  delivered:    0.1,
  opened:       0.5,
  clicked:      0.7,
  converted:    1.0,
  no_response:  0.0,
  unsubscribed: -0.5,
  bounced:      -0.3,
  dlq_dropped:  -1.0,
} as const;

export type OutcomeMetric = keyof typeof OUTCOME_DELTA_MAP;

export const TENANT_STATUS_ENUM = ["active", "paused", "churned"] as const;

export const TenantRegistryMetaSchema = z.object({
  status: z.enum(TENANT_STATUS_ENUM),
  enrolledAt: z.string(),
  updatedAt: z.string(),
});
export type TenantRegistryMeta = z.infer<typeof TenantRegistryMetaSchema>;

const BaseSignal = z.object({
  name: z.enum(SIGNAL_TYPE_ENUM),
  weight: z.number().min(0).max(1).optional(),
});

export const GrowthSignalSchema = z.discriminatedUnion("kind", [
  BaseSignal.extend({ kind: z.literal("string"), value: z.string() }),
  BaseSignal.extend({ kind: z.literal("number"), value: z.number() }),
  BaseSignal.extend({ kind: z.literal("boolean"), value: z.boolean() }),
]);

export const ProductionGrowthSignalSchema = z.object({
  signalId: z.string().optional(),
  signalType: z.string(),
  severity: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.record(z.unknown()).optional(),
  detectedAt: z.number().optional(),
  expiresAt: z.number().optional(),
});

export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);

export const MetadataSchema = z.object({
  provider: z.string(),
  model: z.string(),
  capability: z.enum(CAPABILITY_NAMES),
  promptVersion: z.string(),
  requestSchemaVersion: z.string().regex(SEMVER_REGEX),
  responseSchemaVersion: z.string().regex(SEMVER_REGEX),
  correlationId: z.string(),
  latencyMs: z.number().nonnegative(),
  tokenEstimate: z.number().nonnegative(),
  costEstimate: z.number().nonnegative(),
  fallback: z.boolean(),
  routeReason: z.string(),
  error: z.string().nullable(),
});

export const GrowthNextActionRequestSchema = z.object({
  tenantId: z.string().optional(),
  subjectId: z.string(),
  signals: z.array(z.union([GrowthSignalSchema, ProductionGrowthSignalSchema])),
  outputLocale: z.string().default("en").optional(),
  context: z.record(z.unknown()).optional(),
});

export const GrowthNextActionResponseSchema = z.object({
  action: z.object({
    type: z.enum(ACTION_TYPE_WHITELIST),
    params: z.record(z.unknown()),
    reason: z.string(),
  }),
  riskLevel: RiskLevelSchema,
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
  rawSummary: z.string(),
});

export const GrowthSignalSummarizeRequestSchema = z.object({
  tenantId: z.string().optional(),
  signals: z.array(GrowthSignalSchema),
  outputLocale: z.string().default("en").optional(),
  context: z.record(z.unknown()).optional(),
});

export const GrowthSignalSummarizeResponseSchema = z.object({
  summary: z.string(),
  severity: RiskLevelSchema,
  keyDrivers: z.array(z.string()),
  urgencyWindow: z.string(),
});

export const JourneyCriticRequestSchema = z.object({
  tenantId: z.string().optional(),
  outputLocale: z.string().default("en").optional(),
  journeyState: z.record(z.unknown()),
  priorActions: z.array(z.record(z.unknown())),
  outcomes: z.array(z.record(z.unknown())),
});

export const JourneyCriticResponseSchema = z.object({
  critique: z.string(),
  risks: z.array(z.string()),
  suggestedAdjustments: z.array(z.string()),
});

export const MessageBriefRequestSchema = z.object({
  tenantId: z.string().optional(),
  outputLocale: z.string().default("en").optional(),
  objective: z.string(),
  audience: z.string(),
  channelHints: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
});

export const MessageBriefResponseSchema = z.object({
  headline: z.string(),
  coreMessage: z.string(),
  tone: z.string(),
  cta: z.string(),
  guardrails: z.array(z.string()),
});

export const OutcomeDiagnoseRequestSchema = z.object({
  tenantId: z.string().optional(),
  outputLocale: z.string().default("en").optional(),
  expected: z.record(z.unknown()),
  observed: z.record(z.unknown()),
});

export const OutcomeDiagnoseResponseSchema = z.object({
  diagnosis: z.string(),
  likelyCauses: z.array(z.string()),
  recommendedNextExperiments: z.array(z.string()),
});

export const TenantPriorSchema = z.object({
  preferredTone: z.string().default("clear"),
  avgConfidence: z.number().min(0).max(1).default(0.5),
  topSignalWeights: z
    .array(
      z.object({
        signal: z.string(),
        weight: z.number().min(0).max(1),
      }),
    )
    .default([]),
  lastOutcomeDelta: z.number().default(0),
  interactionCount: z.number().int().nonnegative().default(0),
  calibrationFactor: z.number().min(0.5).max(1.5).default(1),
  consecutiveNegativeOutcomes: z.number().int().nonnegative().default(0),
  strategyWeights: z.object({
    toneVariance: z.number().min(0.1).max(0.7).default(0.2),
    urgencyBias: z.number().min(0).max(1).default(0.5),
    conservatism: z.number().min(0).max(1).default(0.5),
  }),
  updatedAt: z.string(),
});

export const PendingRecommendationSchema = z.object({
  tenantId: z.string(),
  subjectId: z.string(),
  capability: z.enum(CAPABILITY_NAMES),
  action: z.object({
    type: z.enum(ACTION_TYPE_WHITELIST),
    params: z.record(z.unknown()),
    reason: z.string(),
  }),
  confidence: z.number().min(0).max(1),
  riskLevel: RiskLevelSchema,
  correlationId: z.string(),
  sourcePromptVersion: z.string(),
  enqueuedAt: z.string(),
  expiresAt: z.string(),
  experimentId: z.string().optional(),
  arm: z.enum(["treatment", "control"]).optional(),
});

export const OutcomeFeedbackRequestSchema = z.object({
  correlationId: z.string(),
  tenantId: z.string(),
  subjectId: z.string(),
  actionTaken: z.string(),
  outcomeMetric: z.string(),
  delta: z.number(),
  observedAt: z.string(),
});

export const OutcomeFeedbackResponseSchema = z.object({
  priorUpdated: z.boolean(),
  calibrationDelta: z.number(),
});

export const TenantSubjectSchema = z.object({
  subjectId: z.string(),
  tenantId: z.string(),
  signals: z.array(GrowthSignalSchema),
  lastScannedAt: z.string().optional(),
  staleSince: z.string(),
  cooldownUntil: z.string().optional(),
});

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
export type ActionType = (typeof ACTION_TYPE_WHITELIST)[number];
export type ErrorCode = (typeof ERROR_CODES)[number];

export type GrowthSignal = z.infer<typeof GrowthSignalSchema>;
export type GrowthNextActionRequest = z.infer<typeof GrowthNextActionRequestSchema>;
export type GrowthNextActionResponse = z.infer<typeof GrowthNextActionResponseSchema>;
export type GrowthSignalSummarizeRequest = z.infer<typeof GrowthSignalSummarizeRequestSchema>;
export type GrowthSignalSummarizeResponse = z.infer<typeof GrowthSignalSummarizeResponseSchema>;
export type JourneyCriticRequest = z.infer<typeof JourneyCriticRequestSchema>;
export type JourneyCriticResponse = z.infer<typeof JourneyCriticResponseSchema>;
export type MessageBriefRequest = z.infer<typeof MessageBriefRequestSchema>;
export type MessageBriefResponse = z.infer<typeof MessageBriefResponseSchema>;
export type OutcomeDiagnoseRequest = z.infer<typeof OutcomeDiagnoseRequestSchema>;
export type OutcomeDiagnoseResponse = z.infer<typeof OutcomeDiagnoseResponseSchema>;
export type TenantPrior = z.infer<typeof TenantPriorSchema>;
export type PendingRecommendation = z.infer<typeof PendingRecommendationSchema>;
export type OutcomeFeedbackRequest = z.infer<typeof OutcomeFeedbackRequestSchema>;
export type OutcomeFeedbackResponse = z.infer<typeof OutcomeFeedbackResponseSchema>;
export type TenantSubject = z.infer<typeof TenantSubjectSchema>;

export type Metadata = z.infer<typeof MetadataSchema>;

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  metadata: Metadata;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
  };
  metadata: Metadata;
}

export type CapabilityEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;