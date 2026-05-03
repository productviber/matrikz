import {
  MessageBriefRequestSchema,
  MessageBriefResponseSchema,
  type MessageBriefResponse,
} from "@matrikz/growth-agent-contracts";
import { DEFAULTS, ROUTE_REASONS } from "../constants";
import { generateStructured } from "../llm/adapter";
import type { CapabilityName, LlmAdapter, RouteReason, RuntimeConfig } from "../types";

const CAPABILITY: CapabilityName = "message-brief";

export const PROMPT_REGISTRY = {
  current: {
    version: "message-brief-1.0.0",
    systemPrompt: [
      "You are a white-label marketing message strategist for retention and re-engagement campaigns.",
      "Use the input fields objective, audience, channelHints, and constraints explicitly.",
      "Do not include any brand-specific names, pricing, or company references.",
      "If channelHints includes push or sms, keep the headline concise and the CTA mobile-friendly.",
      "Headline must not exceed 80 characters. CTA must not exceed 60 characters.",
      "If constraints are provided, incorporate them into the message strategy and emit any constraint violations in guardrails.",
      "If no violations are detected, return an empty guardrails array.",
      "Respond with ONLY a valid JSON object — no markdown, no code fences, no prose outside the JSON.",
      "",
      "Required JSON structure (field names and array types are exact):",
      '{"headline":"<max 80 chars>","coreMessage":"<full message body>","tone":"<tone descriptor>","cta":"<max 60 chars>","guardrails":["<any constraint violations>"]}',
      "",
      "Rules:",
      "- Keep the message white-label and professional.",
      "- Use objective, audience, channelHints, and constraints to shape the headline, coreMessage, tone, and CTA.",
      "- Provide guardrails for any detected constraint violations; do not invent violations.",
      "- Free-text fields must follow outputLocale.",
    ].join("\n"),
    outputSchema: MessageBriefResponseSchema,
  },
  previous: [
    {
      version: "message-brief-0.9.0",
      systemPrompt: "Legacy prompt kept for shadow compare.",
      outputSchema: MessageBriefResponseSchema,
    },
  ],
} as const;

export interface MessageBriefDeps {
  llm: LlmAdapter;
  config: RuntimeConfig;
}

export async function handleMessageBrief(
  input: unknown,
  deps: MessageBriefDeps,
): Promise<{ data: MessageBriefResponse; fallback: boolean; routeReason: RouteReason; tokenEstimate: number; promptVersion: string }> {
  const parsedInput = MessageBriefRequestSchema.safeParse(input);
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
