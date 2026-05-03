import type { LlmAdapter, LlmGenerateArgs, LlmGenerateResult } from "../../../src/types";

function mkResult(rawText: string): LlmGenerateResult {
  return {
    rawText,
    tokenEstimate: Math.ceil(rawText.length / 4),
    model: "model",
    provider: "workers-ai",
  };
}

export function mockWorkersAi(fixtures: Record<string, unknown>): LlmAdapter {
  return {
    async generateJson<T>(args: LlmGenerateArgs, validate: (value: unknown) => value is T) {
      const payload = fixtures[args.capability];
      if (!validate(payload)) {
        throw new Error("fixture_invalid");
      }
      return {
        parsed: payload,
        llm: mkResult(JSON.stringify(payload)),
      };
    },
  };
}

export function mockWorkersAiTimeout(delayMs = 5): LlmAdapter {
  return {
    async generateJson() {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      throw new Error("timeout");
    },
  };
}

export function mockWorkersAiInvalidOutput(): LlmAdapter {
  return {
    async generateJson() {
      throw new Error("invalid_output");
    },
  };
}
