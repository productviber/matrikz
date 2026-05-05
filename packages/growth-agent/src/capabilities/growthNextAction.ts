import {
  GrowthNextActionRequestSchema,
  GrowthNextActionResponseSchema,
  type GrowthNextActionRequest,
  type GrowthNextActionResponse,
} from "@clodo/growth-agent-contracts";
import { ACTION_TYPE_POLICY, DEFAULTS, KNOWN_ACTION_TYPES, ROUTE_REASONS } from "../constants";
import { generateStructured } from "../llm/adapter";
import type { CapabilityName, LlmAdapter, RouteReason, RuntimeConfig, TenantPrior } from "../types";

type ActionType = (typeof KNOWN_ACTION_TYPES)[number];

function getAllowedActionTypes(calibrationFactor: number): ActionType[] {
  if (calibrationFactor < 0.85) return [...ACTION_TYPE_POLICY.conservative];
  if (calibrationFactor >= 1.1) return [...ACTION_TYPE_POLICY.expansive];
  return [...KNOWN_ACTION_TYPES];
}

const CAPABILITY: CapabilityName = "growth-next-action";

export const PROMPT_REGISTRY = {
  current: {
      version: "growth-next-action-1.2.0",
    systemPrompt: [
      "You are a white-label growth decisioning assistant. Analyze contact signals, subject history, and policy hints to return the optimal next action.",
      "",
      "Use the input fields subjectId, signals, and context.subjectContext + context.policyHints to decide.",
      "If context.subjectContext.recentOutcomes contains prior actions with outcomeType 'no_outcome_observed', prefer a different action type than context.subjectContext.lastActionType.",
      "If context.policyHints.hintBlocked is true, do not propose any action type listed in context.policyHints.hintBlockedReasons.",
      "Use context.subjectContext.lifecycleStage to calibrate urgency: trial_expiring warrants higher urgency than prospect.",
        "If proposing activate, only choose it when context.policyHints.effectiveChannels includes at least one supported delivery channel.",
        "If the subject shows fatigue signals (repeated no_response, churn_risk signal present), prefer pause over any outreach intent.",
      "",
      "Respond with ONLY a valid JSON object — no markdown, no code fences, no prose outside the JSON.",
      "",
      "Required JSON structure (field names and enum values are exact):",
        '{ "action": { "type": "<one of: nurture | activate | convert | recover | pause | escalate | wait>", "params": { "subjectId": "<same as input subjectId>" }, "reason": "<short phrase — why this action>" }, "riskLevel": "<one of: low | medium | high | critical>", "confidence": <number 0.0-1.0>, "explanation": "<1-2 sentences in the outputLocale language>", "rawSummary": "<brief signal interpretation>" }',
      "",
        "Intent definitions:",
        "  nurture   — early lifecycle or low-signal subject; educate, inform, build trust",
        "  activate  — warm/ready subject; invite, prompt, re-engage after warmup",
        "  convert   — high-readiness subject; make offer, push toward commitment",
        "  recover   — at-risk or drifted subject; targeted win-back, re-engagement",
        "  pause     — subject showing fatigue or overload; apply suppression guard",
        "  escalate  — stuck, blocked, or high-risk subject; hand off to human review",
        "  wait      — insufficient signal; take no action until more data is available",
      "",
        "Example output for a contact with high engagement signals and prior outcomes:",
        '{"action":{"type":"activate","params":{"subjectId":"c_123"},"reason":"high engagement signals suggest readiness"},"riskLevel":"low","confidence":0.87,"explanation":"Contact shows strong intent and is ready to be activated.","rawSummary":"High engagement, lifecycle_stage=qualified, no churn risk."}',
        "",
      "Rules:",
        "- action.type MUST be exactly one of the 7 intent values listed above.",
      "- riskLevel MUST be exactly one of: low, medium, high, critical.",
      "- confidence MUST be a decimal number between 0.0 and 1.0.",
      "- explanation and rawSummary MUST be in the language specified by outputLocale in the input.",
      "- action.params MUST include at minimum the subjectId field from the input.",
    ].join("\n"),
    outputSchema: GrowthNextActionResponseSchema,
  },
  previous: [
    {
      version: "growth-next-action-1.1.0",
      systemPrompt: "Legacy prompt kept for one deploy cycle shadow comparisons.",
      outputSchema: GrowthNextActionResponseSchema,
    },
  ],
} as const;

export interface GrowthNextActionDeps {
  llm: LlmAdapter;
  config: RuntimeConfig;
  tenantPrior?: TenantPrior | null;
}

export async function handleGrowthNextAction(
  input: unknown,
  deps: GrowthNextActionDeps,
): Promise<{ data: GrowthNextActionResponse; fallback: boolean; routeReason: RouteReason; tokenEstimate: number; promptVersion: string }> {
  const parsedInput = GrowthNextActionRequestSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new Error("VALIDATION_ERROR");
  }

  const locale = parsedInput.data.outputLocale ?? "en";
  const allowedActions = getAllowedActionTypes(deps.tenantPrior?.calibrationFactor ?? 1.0);
  const systemPrompt = [
    PROMPT_REGISTRY.current.systemPrompt,
    `You may only recommend actions from this set: ${JSON.stringify(allowedActions)}.`,
  ].join("\n");
  const result = await generateStructured(
    deps.llm,
    {
      capability: CAPABILITY,
      model: deps.config.model,
      maxTokens: DEFAULTS.maxTokens[CAPABILITY],
      timeoutMs: deps.config.timeoutMs,
      maxRetries: deps.config.maxRetries,
      outputRepairAttempts: deps.config.outputRepairAttempts,
      systemPrompt,
      userPrompt: JSON.stringify({ input: parsedInput.data, outputLocale: locale, tenantPrior: deps.tenantPrior ?? null }),
    },
    (value: unknown): value is GrowthNextActionResponse => {
      const parsed = PROMPT_REGISTRY.current.outputSchema.safeParse(value);
      return parsed.success && (allowedActions as string[]).includes(parsed.data.action.type);
    },
  );

  return {
    data: clampConfidence(result.parsed),
    fallback: false,
    routeReason: ROUTE_REASONS.predictive,
    tokenEstimate: result.llm.tokenEstimate,
    promptVersion: PROMPT_REGISTRY.current.version,
  };
}

export function deterministicFallback(
  input: GrowthNextActionRequest,
  reason: string,
): GrowthNextActionResponse {
  return {
    action: {
      type: "wait",
      params: {
        cooldownHours: 24,
        subjectId: input.subjectId,
      },
      reason,
    },
    riskLevel: "low",
    confidence: 0.2,
    explanation: "Deterministic fallback selected.",
    rawSummary: "Predictive route unavailable.",
  };
}

function clampConfidence(input: GrowthNextActionResponse): GrowthNextActionResponse {
  return {
    ...input,
    confidence: Math.min(1, Math.max(0, input.confidence)),
  };
}
