import { describe, expect, it } from "vitest";
import { handleMessageBrief } from "../../src/capabilities/messageBrief";
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

    const result = await handleMessageBrief(
      { objective: "acquire", audience: "new users" },
      { llm, config },
    );

    expect(result.data.cta).toBe("Start today");
  });
});
