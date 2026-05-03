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

  it("accepts production-format growth signals", async () => {
    const llm = mockWorkersAi({
      "growth-next-action": {
        action: { type: "manual_review", params: {}, reason: "signal requires review" },
        riskLevel: "medium",
        confidence: 0.72,
        explanation: "The signal indicates a strong but atypical pattern, so manual review is safest.",
        rawSummary: "production-style audit signal received",
      },
    });

    const productionPayload = {
      tenantId: "tenant-1",
      subjectId: "customer-234",
      outputLocale: "en",
      context: {
        subjectContext: {
          recentOutcomes: [{ actionType: "send_via_skrip", outcomeType: "no_outcome_observed", daysSinceExecution: 3, confidence: 0.35 }],
          lastActionType: "send_via_skrip",
          lastActionDaysAgo: 3,
          activeSignalCount: 1,
          lifecycleStage: "prospect",
          pushRegistered: false,
        },
        policyHints: {
          effectiveChannels: ["email"],
          hintBlocked: false,
          hintBlockedReasons: [],
        },
      },
      signals: [
        {
          signalId: "sig-123",
          signalType: "AUDIT_GRADE_LOW_HIGH_FIT",
          severity: "high",
          confidence: 0.85,
          evidence: { auditScore: 0.93 },
          detectedAt: 1690000000,
          expiresAt: 1690003600,
        },
      ],
    };

    const result = await handleGrowthNextAction(productionPayload, { llm, config });

    expect(result.fallback).toBe(false);
    expect(result.data.action.type).toBe("manual_review");
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