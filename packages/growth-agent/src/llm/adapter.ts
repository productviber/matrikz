import { AppError } from "../errors";
import type { CapabilityName, LlmAdapter, LlmGenerateArgs, LlmGenerateResult } from "../types";

export function estimateTokens(input: string): number {
  return Math.ceil(input.length / 4);
}

export async function generateStructured<T>(
  llm: LlmAdapter,
  args: LlmGenerateArgs,
  validate: (value: unknown) => value is T,
): Promise<{ parsed: T; llm: LlmGenerateResult; schemaValid: boolean }> {
  try {
    const result = await llm.generateJson(args, validate);
    return {
      parsed: result.parsed,
      llm: result.llm,
      schemaValid: true,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError("UPSTREAM_FAILURE", "LLM generation failed");
  }
}

export function buildSystemPrompt(capability: CapabilityName): string {
  return [
    "You are a growth decisioning assistant.",
    `Capability: ${capability}`,
    "Return only valid JSON matching the required schema.",
    "Do not include markdown, prose wrappers, or code fences.",
  ].join("\n");
}
