import { describe, expect, it } from "vitest";
import { handleGrowthNextAction } from "../../src/capabilities/growthNextAction";
import { handleMessageBrief } from "../../src/capabilities/messageBrief";
import { handleOutcomeDiagnose } from "../../src/capabilities/outcomeDiagnose";
import {
  DEFAULT_SEMANTIC_EVAL_THRESHOLDS,
  evaluateGrowthNextActionOutput,
  evaluateMessageBriefOutput,
  evaluateOutcomeDiagnoseOutput,
  summarizeSemanticEvalRun,
  type SemanticEvalRunItem,
} from "../../src/evals/semanticEval";
import { mockWorkersAi } from "../unit/mocks/workersAi";
import { semanticEvalConfig, semanticEvalFixtures, type SemanticEvalFixture } from "./semanticFixtures";

async function runFixture(fixture: SemanticEvalFixture): Promise<SemanticEvalRunItem> {
  const llm = mockWorkersAi({ [fixture.capability]: fixture.modelResponse });
  const startedAt = Date.now();

  if (fixture.capability === "growth-next-action") {
    const response = await handleGrowthNextAction(fixture.input, { llm, config: semanticEvalConfig });
    return {
      result: evaluateGrowthNextActionOutput(fixture.id, response.data, fixture.expected),
      schemaValid: true,
      fallback: response.fallback,
      latencyMs: Date.now() - startedAt,
      tokenEstimate: response.tokenEstimate,
    };
  }

  if (fixture.capability === "message-brief") {
    const response = await handleMessageBrief(fixture.input, { llm, config: semanticEvalConfig });
    return {
      result: evaluateMessageBriefOutput(fixture.id, response.data, fixture.expected),
      schemaValid: true,
      fallback: response.fallback,
      latencyMs: Date.now() - startedAt,
      tokenEstimate: response.tokenEstimate,
    };
  }

  const response = await handleOutcomeDiagnose(fixture.input, { llm, config: semanticEvalConfig });
  return {
    result: evaluateOutcomeDiagnoseOutput(fixture.id, response.data, fixture.expected),
    schemaValid: true,
    fallback: response.fallback,
    latencyMs: Date.now() - startedAt,
    tokenEstimate: response.tokenEstimate,
  };
}

describe("semantic evaluation harness", () => {
  it("passes deterministic semantic fixtures for rollout gating", async () => {
    const items = await Promise.all(semanticEvalFixtures.map((fixture) => runFixture(fixture)));
    const summary = summarizeSemanticEvalRun(items);

    expect(summary.total).toBe(semanticEvalFixtures.length);
    expect(summary.schemaValidityRate).toBe(DEFAULT_SEMANTIC_EVAL_THRESHOLDS.schemaValidityRateMin);
    expect(summary.fallbackRate).toBeLessThanOrEqual(DEFAULT_SEMANTIC_EVAL_THRESHOLDS.fallbackRateMax);
    expect(summary.passRate).toBeGreaterThanOrEqual(DEFAULT_SEMANTIC_EVAL_THRESHOLDS.passRateMin);
    expect(summary.passed).toBe(true);
    expect(summary.failures).toEqual([]);
  });

  it("detects an unsafe growth-next-action regression", () => {
    const suppressedFixture = semanticEvalFixtures.find((fixture) => fixture.id === "gna-suppressed-contact-wait");
    expect(suppressedFixture?.capability).toBe("growth-next-action");
    if (!suppressedFixture || suppressedFixture.capability !== "growth-next-action") {
      throw new Error("Missing suppressed contact fixture");
    }

    const result = evaluateGrowthNextActionOutput(
      "unsafe-suppressed-regression",
      {
        action: {
          type: "activate",
          params: { subjectId: "contact-suppressed" },
          reason: "positive intent warrants activation",
        },
        riskLevel: "low",
        confidence: 0.91,
        explanation: "Activate immediately based on intent.",
        rawSummary: "Intent is positive.",
      },
      suppressedFixture.expected,
    );

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes("forbidden_action_type"))).toBe(true);
  });
});