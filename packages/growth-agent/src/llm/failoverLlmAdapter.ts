import { AppError } from "../errors";
import type { LlmAdapter, LlmGenerateArgs, LlmGenerateResult } from "../types";

/**
 * Wraps a primary and a secondary LlmAdapter.
 * When the primary throws UPSTREAM_QUOTA_EXCEEDED or a connectivity-class
 * UPSTREAM_FAILURE the secondary is attempted and a llm_failover event is logged.
 * All other errors (UPSTREAM_TIMEOUT, OUTPUT_SCHEMA_INVALID, etc.) propagate
 * immediately without engaging the secondary.
 */
export class FailoverLlmAdapter implements LlmAdapter {
  constructor(
    private readonly primary: LlmAdapter,
    private readonly secondary: LlmAdapter,
  ) {}

  async generateJson<T>(
    args: LlmGenerateArgs,
    validate: (value: unknown) => value is T,
  ): Promise<{ parsed: T; llm: LlmGenerateResult }> {
    try {
      return await this.primary.generateJson(args, validate);
    } catch (primaryError) {
      if (
        primaryError instanceof AppError &&
        (primaryError.code === "UPSTREAM_QUOTA_EXCEEDED" ||
          primaryError.code === "UPSTREAM_FAILURE")
      ) {
        console.log(
          JSON.stringify({
            type: "llm_failover",
            capability: args.capability,
            reason: primaryError.code,
          }),
        );
        return await this.secondary.generateJson(args, validate);
      }
      throw primaryError;
    }
  }
}
