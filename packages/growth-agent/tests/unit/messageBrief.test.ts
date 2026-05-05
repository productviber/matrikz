import { describe, expect, it } from "vitest";
import { handleMessageBrief } from "../../src/capabilities/messageBrief";
import { mockWorkersAi } from "./mocks/workersAi";
import type { RuntimeConfig } from "../../src/types";
import { detailedMessageBriefPayload, invalidMessageBriefPayload } from "../fixtures/payloads";

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

describe("message-brief", () => {
  it("returns brief", async () => {
    const llm = mockWorkersAi({
      "message-brief": {
        headline: "Save time",
        coreMessage: "Automate now",
        tone: "clear",
        cta: "Start today",
        guardrails: ["no_overpromise"],
      },
    });

    const result = await handleMessageBrief(detailedMessageBriefPayload, { llm, config });

    expect(result.data.cta).toBe("Start today");
  });

  it("throws validation error for malformed input", async () => {
    const llm = mockWorkersAi({
      "message-brief": {
        headline: "Save time",
        coreMessage: "Automate now",
        tone: "clear",
        cta: "Start today",
        guardrails: ["no_overpromise"],
      },
    });

    await expect(handleMessageBrief(invalidMessageBriefPayload, { llm, config })).rejects.toThrow(
      "VALIDATION_ERROR",
    );
  });
});