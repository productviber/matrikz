import { AppError } from "../errors";
import { estimateTokens } from "./adapter";
import type { LlmAdapter, LlmGenerateArgs, LlmGenerateResult } from "../types";

interface OpenAiChatResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
}

/**
 * LLM adapter for any OpenAI-compatible HTTP endpoint.
 * Used as a secondary provider when Workers AI quota is exhausted or unavailable.
 *
 * Cost policy: secondary provider usage incurs third-party API costs at the
 * provider's standard rate. Only activate SECONDARY_LLM_PROVIDER_URL and
 * SECONDARY_LLM_PROVIDER_API_KEY after reviewing the expected cost impact with
 * the engineering lead. See docs/api-contract.md for provider cost policy.
 * The provider is contacted only when UPSTREAM_QUOTA_EXCEEDED or a connectivity-
 * class UPSTREAM_FAILURE is returned by the primary Workers AI adapter.
 */
export class FetchLlmAdapter implements LlmAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async generateJson<T>(
    args: LlmGenerateArgs,
    validate: (value: unknown) => value is T,
  ): Promise<{ parsed: T; llm: LlmGenerateResult }> {
    const controller = new AbortController();
    const deadline = args.totalDeadlineMs ?? args.timeoutMs;
    const timer = setTimeout(() => controller.abort(), deadline);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: args.model,
          messages: [
            { role: "system", content: args.systemPrompt },
            { role: "user", content: args.userPrompt },
          ],
          max_tokens: args.maxTokens,
          temperature: args.temperatureOverride ?? 0.2,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof Error && error.name === "AbortError") {
        throw new AppError("UPSTREAM_TIMEOUT", "Secondary provider timeout");
      }
      throw new AppError("UPSTREAM_FAILURE", "Secondary provider fetch failed");
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new AppError("UPSTREAM_QUOTA_EXCEEDED", "Secondary provider quota exceeded");
    }
    if (!response.ok) {
      throw new AppError("UPSTREAM_FAILURE", `Secondary provider HTTP ${response.status}`);
    }

    const body = (await response.json()) as OpenAiChatResponse;
    const text = body.choices?.[0]?.message?.content ?? "";
    if (!text) {
      throw new AppError("UPSTREAM_FAILURE", "Empty secondary provider output");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AppError("OUTPUT_SCHEMA_INVALID", "Non-JSON from secondary provider");
    }

    if (!validate(parsed)) {
      throw new AppError("OUTPUT_SCHEMA_INVALID", "Schema invalid on secondary provider output");
    }

    return {
      parsed: parsed as T,
      llm: {
        rawText: text,
        tokenEstimate: estimateTokens(text),
        model: args.model,
        provider: "secondary-fetch",
      },
    };
  }
}
