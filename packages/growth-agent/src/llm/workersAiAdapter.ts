import { AppError } from "../errors";
import { estimateTokens } from "./adapter";
import type { GrowthAgentEnv, LlmAdapter, LlmGenerateArgs, LlmGenerateResult } from "../types";

interface WorkersAiResponse {
  response?: string;
  result?: {
    response?: string;
    output_text?: string;
  };
  output_text?: string;
}

export class WorkersAiAdapter implements LlmAdapter {
  constructor(private readonly env: GrowthAgentEnv) {}

  async generateJson<T>(
    args: LlmGenerateArgs,
    validate: (value: unknown) => value is T,
  ): Promise<{ parsed: T; llm: LlmGenerateResult }> {
    if (!this.env.WORKERS_AI) {
      throw new AppError("UPSTREAM_FAILURE", "AI binding unavailable");
    }

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= args.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), args.timeoutMs);

      try {
        const raw = (await runWorkersAi(this.env, args, controller.signal, args.userPrompt)) as WorkersAiResponse;

        clearTimeout(timeout);

        const text = extractText(raw);
        if (!text) {
          throw new AppError("UPSTREAM_FAILURE", "Empty model output");
        }

        let parsed = parseJson(text);
        if (!parsed || !validate(parsed)) {
          const repaired = await repairOutput(
            this.env,
            args,
            text,
            args.outputRepairAttempts,
            controller.signal,
            validate,
          );
          if (!repaired) {
            console.log(
              JSON.stringify({
                type: "output_schema_invalid",
                capability: args.capability,
                outputHash: hashOutput(text),
              }),
            );
            throw new AppError("OUTPUT_SCHEMA_INVALID", "Schema validation failed");
          }
          parsed = repaired;
        }

        return {
          parsed: parsed as T,
          llm: {
            rawText: text,
            tokenEstimate: estimateTokens(text),
            model: args.model,
            provider: "workers-ai",
          },
        };
      } catch (error) {
        clearTimeout(timeout);
        lastError = error;

        if (error instanceof AppError && error.code === "UPSTREAM_FAILURE" && attempt < args.maxRetries) {
          continue;
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw new AppError("UPSTREAM_TIMEOUT", "Request timed out");
        }
        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new AppError("UPSTREAM_FAILURE", "Unknown error");
  }
}

async function runWorkersAi(
  env: GrowthAgentEnv,
  args: LlmGenerateArgs,
  signal: AbortSignal,
  userPrompt: string,
): Promise<unknown> {
  if (!env.WORKERS_AI) throw new AppError("UPSTREAM_FAILURE", "AI binding unavailable");

  const result = await env.WORKERS_AI.run(
    args.model,
    {
      messages: [
        { role: "system", content: args.systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: args.maxTokens,
      response_format: { type: "json_object" },
    },
    { signal },
  );

  // Workers AI returns 429 as a thrown error or non-ok response depending on binding version.
  if (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    (result as { status: number }).status === 429
  ) {
    throw new AppError("UPSTREAM_QUOTA_EXCEEDED", "Workers AI quota exceeded");
  }

  return result;
}

function extractText(raw: WorkersAiResponse): string | null {
  return raw.response ?? raw.result?.response ?? raw.result?.output_text ?? raw.output_text ?? null;
}

function parseJson(text: string): unknown | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function repairOutput<T>(
  env: GrowthAgentEnv,
  args: LlmGenerateArgs,
  badText: string,
  attempts: number,
  signal: AbortSignal,
  validate: (value: unknown) => value is T,
): Promise<T | null> {
  if (attempts <= 0) return null;

  const repairPrompt = [
    "The previous response was not valid JSON matching the required schema.",
    "Original output (do not repeat it):",
    badText.slice(0, 200),
    "Return ONLY a corrected JSON object.",
  ].join("\n");

  try {
    const raw = (await runWorkersAi(env, { ...args, userPrompt: repairPrompt }, signal, repairPrompt)) as WorkersAiResponse;
    const text = extractText(raw);
    if (!text) return null;
    const parsed = parseJson(text);
    if (parsed && validate(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

function hashOutput(text: string): string {
  // Simple non-crypto hash for logging — avoids logging raw LLM output.
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}
