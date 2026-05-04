import { describe, expect, it } from "vitest";
import {
  GrowthNextActionResponseSchema,
  GrowthSignalSummarizeResponseSchema,
  JourneyCriticResponseSchema,
  MessageBriefResponseSchema,
  OutcomeDiagnoseResponseSchema,
} from "@matrikz/growth-agent-contracts";
import { degradedResponseFor } from "../../src/degraded";

// Validates that every deterministic fallback emitted by degradedResponseFor
// satisfies the same Zod schema the live capability path uses.
// This is the schema-parity gate referenced in the rollout plan.

const SAMPLE_GROWTH_NEXT_ACTION_INPUT = {
  subjectId: "subject-abc",
  signals: [{ kind: "number" as const, name: "intent" as const, value: 0.9 }],
};

const SAMPLE_GROWTH_SIGNAL_SUMMARIZE_INPUT = {
  signals: [
    { kind: "number" as const, name: "intent" as const, value: 0.7 },
    { kind: "boolean" as const, name: "engagement" as const, value: true },
    { kind: "string" as const, name: "lifecycle_stage" as const, value: "growth" },
  ],
};

const SAMPLE_MESSAGE_BRIEF_INPUT = {
  objective: "Re-engage dormant users",
  audience: "enterprise",
};

describe("degraded response schema guarantees", () => {
  it("growth-next-action fallback satisfies response schema", () => {
    const result = degradedResponseFor(
      "growth-next-action",
      SAMPLE_GROWTH_NEXT_ACTION_INPUT,
      "budget_exhausted",
    );
    const parsed = GrowthNextActionResponseSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("growth-signal-summarize fallback satisfies response schema", () => {
    const result = degradedResponseFor(
      "growth-signal-summarize",
      SAMPLE_GROWTH_SIGNAL_SUMMARIZE_INPUT,
      "upstream_quota_exceeded",
    );
    const parsed = GrowthSignalSummarizeResponseSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("journey-critic fallback satisfies response schema", () => {
    const result = degradedResponseFor("journey-critic", {}, "output_schema_invalid");
    const parsed = JourneyCriticResponseSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("message-brief fallback satisfies response schema", () => {
    const result = degradedResponseFor(
      "message-brief",
      SAMPLE_MESSAGE_BRIEF_INPUT,
      "budget_exhausted",
    );
    const parsed = MessageBriefResponseSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("outcome-diagnose fallback satisfies response schema", () => {
    const result = degradedResponseFor("outcome-diagnose", {}, "upstream_quota_exceeded");
    const parsed = OutcomeDiagnoseResponseSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("unknown capability returns a safe non-null object", () => {
    // @ts-expect-error — intentional invalid capability for safety test
    const result = degradedResponseFor("unknown-capability", {}, "test");
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });
});
