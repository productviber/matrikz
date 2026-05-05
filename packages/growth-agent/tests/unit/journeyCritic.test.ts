import { describe, expect, it } from "vitest";
import { handleJourneyCritic } from "../../src/capabilities/journeyCritic";
import { mockWorkersAi } from "./mocks/workersAi";
import type { RuntimeConfig } from "../../src/types";
import { detailedJourneyCriticPayload, invalidJourneyCriticPayload } from "../fixtures/payloads";

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
  proactiveScanEnabled: false,
  proactiveScanCooldownHours: 24,
  priorTtlDays: 30,
  calibrationRecalcAfterN: 10,
  outcomeRetentionDays: 90,
  auditSampleRate: 0.1,
  proactiveScanBatchSize: 50,
  maxPendingPerTenant: 5,
  featureFlags: {
    "growth-next-action": true,
    "growth-signal-summarize": true,
    "journey-critic": true,
    "message-brief": true,
    "outcome-diagnose": true,
  },
};

describe("journey-critic", () => {
  it("returns critique", async () => {
    const llm = mockWorkersAi({
      "journey-critic": {
        critique: "state is stale",
        risks: ["dropoff"],
        suggestedAdjustments: ["shorten step"],
      },
    });

    const result = await handleJourneyCritic(detailedJourneyCriticPayload, { llm, config });

    expect(result.data.risks[0]).toBe("dropoff");
  });

  it("throws validation error for malformed input", async () => {
    const llm = mockWorkersAi({
      "journey-critic": {
        critique: "state is stale",
        risks: ["dropoff"],
        suggestedAdjustments: ["shorten step"],
      },
    });

    await expect(handleJourneyCritic(invalidJourneyCriticPayload, { llm, config })).rejects.toThrow(
      "VALIDATION_ERROR",
    );
  });
});