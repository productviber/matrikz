import {
  GrowthNextActionRequestSchema,
  GrowthNextActionResponseSchema,
  type GrowthNextActionRequest,
  type GrowthNextActionResponse,
} from "@matrikz/growth-agent-contracts";
import { DEFAULTS, ROUTE_REASONS } from "../constants";
import { generateStructured } from "../llm/adapter";
import type { CapabilityName, LlmAdapter, RouteReason, RuntimeConfig } from "../types";

const CAPABILITY: CapabilityName = "growth-next-action";

export const PROMPT_REGISTRY = {
  current: {
    version: "growth-next-action-1.0.0",
    systemPrompt: [
      "You are a growth decisioning assistant.",
      "Return strict JSON only.",
      "Structured fields stay in English constants.",
      "Free-text explanation fields must follow outputLocale.",
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
