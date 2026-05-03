import { z } from "zod";

export const CAPABILITY_NAMES = [
  "growth-next-action",
  "growth-signal-summarize",
  "journey-critic",
  "message-brief",
  "outcome-diagnose",
] as const;

// Must match AGENT_ACTION_TYPE in packages/marketer/src/constants.ts exactly.
export const ACTION_TYPE_WHITELIST = [
  "wait",
  "manual_review",
  "enroll_sequence",
  "send_via_skrip",
  "pause_campaign",
  "start_campaign",
  "pause_contact",
  "escalate_to_human",
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
  "INTERNAL_FALLBACK",
  "INTERNAL_ERROR",
] as const;

export const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

/**
 * Correlation ID format: base36-timestamp + hyphen + base36-random (4+ chars).
 * Matches the output of getCorrelationId() in packages/marketer/src/lib/correlation.ts:
 *   `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
 */
export const CORRELATION_ID_REGEX = /^[a-z0-9]+-[a-z0-9]{4,}$/;

export const SIGNAL_TYPE_ENUM = [
  "intent",
  "engagement",
  "churn_risk",
  "lifecycle_stage",
  "revenue",
  "activity",
] as const;

const BaseSignal = z.object({
  name: z.enum(SIGNAL_TYPE_ENUM),
  weight: z.number().min(0).max(1).optional(),
});

export const GrowthSignalSchema = z.discriminatedUnion("kind", [
  BaseSignal.extend({ kind: z.literal("string"), value: z.string() }),
  BaseSignal.extend({ kind: z.literal("number"), value: z.number() }),
  BaseSignal.extend({ kind: z.literal("boolean"), value: z.boolean() }),
]);

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
  signals: z.array(GrowthSignalSchema),
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
