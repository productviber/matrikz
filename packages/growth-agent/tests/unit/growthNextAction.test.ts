import { describe, expect, it } from "vitest";
import { handleGrowthNextAction } from "../../src/capabilities/growthNextAction";
import { mockWorkersAi, mockWorkersAiInvalidOutput } from "./mocks/workersAi";
import type { RuntimeConfig } from "../../src/types";
import { detailedGrowthNextActionPayload, invalidGrowthNextActionPayload } from "../fixtures/payloads";

const config: RuntimeConfig = {
  appVersion: "0.1.0",
  requestSchemaVersion: "1.0.0",
  responseSchemaVersion: "1.0.0",
  model: "model",
  timeoutMs: 100,
  maxRetries: 0,
  outputRepairAttempts: 1,
  budgetPerTenantPerMinute: 10,
  rateLimitPerTenantCapabilityPerMinute: 10,
  secretRotationWindowHours: 24,
  featureFlags: {
    "growth-next-action": true,
    "growth-signal-summarize": true,
    "journey-critic": true,
    "message-brief": true,
    "outcome-diagnose": true,
  },
};

describe("growth-next-action", () => {
  it("returns model result when valid", async () => {
    const llm = mockWorkersAi({
      "growth-next-action": {
        action: { type: "send_message", params: {}, reason: "high intent" },
        riskLevel: "low",
        confidence: 0.83,
        explanation: "Act now",
        rawSummary: "intent spike",
      },
    });

    const result = await handleGrowthNextAction(detailedGrowthNextActionPayload, { llm, config });

    expect(result.fallback).toBe(false);
    expect(result.data.action.type).toBe("send_message");
  });

  it("throws validation error for malformed input", async () => {
    const llm = mockWorkersAi({
      "growth-next-action": {
        action: { type: "send_message", params: {}, reason: "high intent" },
        riskLevel: "low",
        confidence: 0.83,
        explanation: "Act now",
        rawSummary: "intent spike",
      },
    });

    await expect(
      handleGrowthNextAction(invalidGrowthNextActionPayload, { llm, config }),
    ).rejects.toThrow("VALIDATION_ERROR");
  });

  it("throws upstream failure when LLM output is invalid", async () => {
    const llm = mockWorkersAiInvalidOutput();

    await expect(handleGrowthNextAction(detailedGrowthNextActionPayload, { llm, config })).rejects.toThrow(
      "LLM generation failed",
    );
  });
});