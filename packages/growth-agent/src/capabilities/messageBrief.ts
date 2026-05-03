import {
  MessageBriefRequestSchema,
  MessageBriefResponseSchema,
  type MessageBriefResponse,
} from "@clodo/growth-agent-contracts";
import { DEFAULTS, ROUTE_REASONS } from "../constants";
import { generateStructured } from "../llm/adapter";
import type { CapabilityName, LlmAdapter, RouteReason, RuntimeConfig } from "../types";

const CAPABILITY: CapabilityName = "message-brief";

export const PROMPT_REGISTRY = {
  current: {
    version: "message-brief-1.0.0",
    systemPrompt: [
      "You are a marketing message strategist.",
      "Return strict JSON only.",
      "Free-text fields must follow outputLocale.",
    ].join("\n"),
    outputSchema: MessageBriefResponseSchema,
  },
  previous: [],
} as const;

export async function handleMessageBrief(
  input: unknown,
  deps: { llm: LlmAdapter; config: RuntimeConfig },
): Promise<{ data: MessageBriefResponse; fallback: boolean; routeReason: RouteReason; tokenEstimate: number; promptVersion: string }> {
  const parsedInput = MessageBriefRequestSchema.safeParse(input);
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
    (value: unknown): value is MessageBriefResponse =>
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
