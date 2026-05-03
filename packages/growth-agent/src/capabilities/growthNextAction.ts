import {
  GrowthNextActionRequestSchema,
  GrowthNextActionResponseSchema,
  type GrowthNextActionRequest,
  type GrowthNextActionResponse,
} from "@clodo/growth-agent-contracts";
import { DEFAULTS, ROUTE_REASONS } from "../constants";
import { generateStructured } from "../llm/adapter";
import type { CapabilityName, LlmAdapter, RouteReason, RuntimeConfig } from "../types";

const CAPABILITY: CapabilityName = "growth-next-action";

export const PROMPT_REGISTRY = {
  current: {
    version: "growth-next-action-1.1.0",
    systemPrompt: [
      "You are a growth decisioning assistant. Analyze contact signals and return the optimal next action.",
      "",
      "Respond with ONLY a valid JSON object — no markdown, no code fences, no prose outside the JSON.",
      "",
      "Required JSON structure (field names and enum values are exact):",
      '{ "action": { "type": "<one of: wait | manual_review | enroll_sequence | send_via_skrip | pause_campaign | start_campaign | pause_contact | escalate_to_human>", "params": { "subjectId": "<same as input subjectId>" }, "reason": "<short phrase — why this action>" }, "riskLevel": "<one of: low | medium | high | critical>", "confidence": <number 0.0-1.0>, "explanation": "<1-2 sentences in the outputLocale language>", "rawSummary": "<brief signal interpretation>" }',
      "",
      "Example output for a contact with high engagement signals:",
      '{"action":{"type":"enroll_sequence","params":{"sequenceId":"onboarding","subjectId":"c_123"},"reason":"high engagement signals suggest readiness"},"riskLevel":"low","confidence":0.87,"explanation":"Contact shows strong intent and is ready for onboarding sequence.","rawSummary":"High engagement, lifecycle_stage=qualified, no churn risk."}',
      "",
      "Rules:",
      "- action.type MUST be exactly one of the 8 enum values listed above.",
      "- riskLevel MUST be exactly one of: low, medium, high, critical.",
      "- confidence MUST be a decimal number between 0.0 and 1.0.",
      "- explanation and rawSummary MUST be in the language specified by outputLocale in the input.",
      "- action.params MUST include at minimum the subjectId field from the input.",
    ].join("\n"),
    outputSchema: GrowthNextActionResponseSchema,
  },
  previous: [
    {
      version: "growth-next-action-0.9.0",
      systemPrompt: "Legacy prompt kept for one deploy cycle shadow comparisons.",
      outputSchema: GrowthNextActionResponseSchema,
    },
  ],
} as const;

export interface GrowthNextActionDeps {
  llm: LlmAdapter;
  config: RuntimeConfig;
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
  const result = await generateStructured(
    deps.llm,
    {
      capability: CAPABILITY,
      model: deps.config.model,
      maxTokens: DEFAULTS.maxTokens[CAPABILITY],
      timeoutMs: deps.config.timeoutMs,
      maxRetries: deps.config.maxRetries,
      outputRepairAttempts: deps.config.outputRepairAttempts,
      systemPrompt: PROMPT_REGISTRY.current.systemPrompt,
      userPrompt: JSON.stringify({ input: parsedInput.data, outputLocale: locale }),
    },
    (value: unknown): value is GrowthNextActionResponse =>
      PROMPT_REGISTRY.current.outputSchema.safeParse(value).success,
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
    explanation: "Deterministic fallback selected for safe continuity.",
    rawSummary: "Predictive route unavailable.",
  };
}

function clampConfidence(response: GrowthNextActionResponse): GrowthNextActionResponse {
  return {
    ...response,
    confidence: Math.max(0, Math.min(1, response.confidence)),
  };
}
