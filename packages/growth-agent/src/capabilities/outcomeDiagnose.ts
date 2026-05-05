import {
  OutcomeDiagnoseRequestSchema,
  OutcomeDiagnoseResponseSchema,
  type OutcomeDiagnoseResponse,
} from "@matrikz/growth-agent-contracts";
import { DEFAULTS, ROUTE_REASONS } from "../constants";
import { generateStructured } from "../llm/adapter";
import type { CapabilityName, LlmAdapter, RouteReason, RuntimeConfig, TenantPrior } from "../types";

const CAPABILITY: CapabilityName = "outcome-diagnose";

export const PROMPT_REGISTRY = {
  current: {
    version: "outcome-diagnose-1.0.0",
    systemPrompt: "Return strict JSON only. Localize free-text fields to outputLocale.",
    outputSchema: OutcomeDiagnoseResponseSchema,
  },
  previous: [
    {
      version: "outcome-diagnose-0.9.0",
      systemPrompt: "Legacy prompt kept for shadow compare.",
      outputSchema: OutcomeDiagnoseResponseSchema,
    },
  ],
} as const;

export interface OutcomeDiagnoseDeps {
  llm: LlmAdapter;
  config: RuntimeConfig;
}

export async function handleOutcomeDiagnose(
  input: unknown,
  deps: { llm: LlmAdapter; config: RuntimeConfig; tenantPrior?: TenantPrior | null },
): Promise<{ data: OutcomeDiagnoseResponse; fallback: boolean; routeReason: RouteReason; tokenEstimate: number; promptVersion: string }> {
  const parsedInput = OutcomeDiagnoseRequestSchema.safeParse(input);
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
      userPrompt: JSON.stringify({ input: parsedInput.data, outputLocale: locale, tenantPrior: deps.tenantPrior ?? null }),
    },
    (value: unknown): value is OutcomeDiagnoseResponse =>
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
