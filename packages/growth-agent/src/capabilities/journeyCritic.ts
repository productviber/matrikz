import {
  JourneyCriticRequestSchema,
  JourneyCriticResponseSchema,
  type JourneyCriticResponse,
} from "@matrikz/growth-agent-contracts";
import { DEFAULTS, ROUTE_REASONS } from "../constants";
import { generateStructured } from "../llm/adapter";
import type { CapabilityName, LlmAdapter, RouteReason, RuntimeConfig } from "../types";

const CAPABILITY: CapabilityName = "journey-critic";

export const PROMPT_REGISTRY = {
  current: {
    version: "journey-critic-1.0.0",
    systemPrompt: "Return strict JSON only. Localize free-text fields to outputLocale.",
    outputSchema: JourneyCriticResponseSchema,
  },
  previous: [
    {
      version: "journey-critic-0.9.0",
      systemPrompt: "Legacy prompt kept for shadow compare.",
      outputSchema: JourneyCriticResponseSchema,
    },
  ],
} as const;

export interface JourneyCriticDeps {
  llm: LlmAdapter;
  config: RuntimeConfig;
}

export async function handleJourneyCritic(
  input: unknown,
  deps: JourneyCriticDeps,
): Promise<{ data: JourneyCriticResponse; fallback: boolean; routeReason: RouteReason; tokenEstimate: number; promptVersion: string }> {
  const parsedInput = JourneyCriticRequestSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new Error("VALIDATION_ERROR");
  }

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
      userPrompt: JSON.stringify(parsedInput.data),
    },
    (value: unknown): value is JourneyCriticResponse =>
      PROMPT_REGISTRY.current.outputSchema.safeParse(value).success,
  );

  return {
    data: result.parsed,
    fallback: false,
    routeReason: ROUTE_REASONS.predictive,
    tokenEstimate: result.llm.tokenEstimate,
    promptVersion: PROMPT_REGISTRY.current.version,
  };
}
