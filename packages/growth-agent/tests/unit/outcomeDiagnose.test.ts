import { describe, expect, it } from "vitest";
import { handleOutcomeDiagnose } from "../../src/capabilities/outcomeDiagnose";
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

describe("outcome-diagnose", () => {
  it("returns diagnosis", async () => {
    const llm = mockWorkersAi({
      "outcome-diagnose": {
        diagnosis: "timing mismatch",
        likelyCauses: ["channel delay"],
        recommendedNextExperiments: ["time-window-shift"],
      },
    });

    const result = await handleOutcomeDiagnose(
      { expected: {}, observed: {} },
      { llm, config },
    );

    expect(result.data.diagnosis).toBe("timing mismatch");
  });
});
