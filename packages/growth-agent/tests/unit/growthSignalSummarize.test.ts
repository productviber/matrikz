import { describe, expect, it } from "vitest";
import { handleGrowthSignalSummarize } from "../../src/capabilities/growthSignalSummarize";
import { mockWorkersAi } from "./mocks/workersAi";
import type { RuntimeConfig } from "../../src/types";

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

describe("growth-signal-summarize", () => {
  it("returns model summary", async () => {
    const llm = mockWorkersAi({
      "growth-signal-summarize": {
        summary: "signal trend",
        severity: "medium",
        keyDrivers: ["intent"],
        urgencyWindow: "next_72_hours",
      },
    });

    const result = await handleGrowthSignalSummarize(
      { signals: [{ kind: "number", name: "intent", value: 8 }] },
      { llm, config },
    );

    expect(result.fallback).toBe(false);
    expect(result.data.summary).toContain("signal");
  });
});
