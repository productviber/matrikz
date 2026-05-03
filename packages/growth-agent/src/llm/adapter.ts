import type { LlmAdapter, LlmGenerateArgs } from "../types";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function generateStructured<T>(
  llm: LlmAdapter,
  args: LlmGenerateArgs,
  validate: (value: unknown) => value is T,
): Promise<{ parsed: T; llm: { rawText: string; tokenEstimate: number; model: string; provider: string } }> {
  return llm.generateJson(args, validate);
}
