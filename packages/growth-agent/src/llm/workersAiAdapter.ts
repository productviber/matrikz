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
          console.log(
            JSON.stringify({
              type: "llm_retry_attempt",
              capability: args.capability,
              attempt,
              maxRetries: args.maxRetries,
              reason: error.code,
            }),
          );
          continue;
        }
        if (error instanceof Error && error.name === "AbortError") {
          console.log(
            JSON.stringify({ type: "llm_timeout", capability: args.capability, attempt, timeoutMs: args.timeoutMs }),
          );
          throw new AppError("UPSTREAM_TIMEOUT", "Upstream timeout");
        }
        if (isQuotaError(error)) {
          console.log(
            JSON.stringify({ type: "llm_quota_exceeded", capability: args.capability, attempt }),
          );
          throw new AppError("UPSTREAM_QUOTA_EXCEEDED", "Upstream quota exceeded");
        }
        if (error instanceof AppError) {
          throw error;
        }
        if (attempt >= args.maxRetries) {
          break;
        }
      }
    }

    if (lastError instanceof AppError) {
      throw lastError;
    }

    throw new AppError("UPSTREAM_FAILURE", "Provider failure");
  }
}

async function runWorkersAi(
  env: GrowthAgentEnv,
  args: LlmGenerateArgs,
  signal: AbortSignal,
  userPrompt: string,
): Promise<unknown> {
  return env.WORKERS_AI!.run(
    args.model,
    {
      messages: [
        { role: "system", content: args.systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: args.maxTokens,
      temperature: 0.2,
      response_format: { type: "json_object" },
    },
    { signal },
  );
}

async function repairOutput<T>(
  env: GrowthAgentEnv,
  args: LlmGenerateArgs,
  badOutput: string,
  attempts: number,
  signal: AbortSignal,
  validate: (value: unknown) => value is T,
): Promise<T | null> {
  for (let i = 0; i < attempts; i += 1) {
    const repairedRaw = (await runWorkersAi(
      env,
      args,
      signal,
      [
        "Repair this output into strict valid JSON for the same schema.",
        "Return only JSON object.",
        badOutput,
      ].join("\n"),
    )) as WorkersAiResponse;
    const repairedText = extractText(repairedRaw);
    const parsed = parseJson(repairedText);
    if (parsed && validate(parsed)) {
      return parsed;
    }
  }
  return null;
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("quota") || message.includes("rate limit") || message.includes("429");
}

function hashOutput(raw: string): string {
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash *= 16777619;
  }
  return `fnv1a_${Math.abs(hash >>> 0).toString(16)}`;
}

function extractText(raw: WorkersAiResponse): string {
  if (typeof raw.response === "string") {
    return raw.response;
  }
  if (typeof raw.output_text === "string") {
    return raw.output_text;
  }
  if (raw.result) {
    if (typeof raw.result.response === "string") {
      return raw.result.response;
    }
    if (typeof raw.result.output_text === "string") {
      return raw.result.output_text;
    }
  }
  return "";
}
