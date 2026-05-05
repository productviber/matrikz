import { describe, expect, it, vi } from "vitest";
import { handleOutcomeFeedback } from "../../src/capabilities/outcomeFeedback";
import type { GrowthAgentEnv, RuntimeConfig } from "../../src/types";

const baseConfig: RuntimeConfig = {
  appVersion: "0.1.0",
  requestSchemaVersion: "1.0.0",
  responseSchemaVersion: "1.0.0",
  model: "@cf/meta/llama-3.1-8b-instruct",
  timeoutMs: 3500,
  maxRetries: 1,
  outputRepairAttempts: 1,
  budgetPerTenantPerMinute: 120,
  rateLimitPerTenantCapabilityPerMinute: 180,
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

const validPayload = {
  correlationId: "corr-abc-123",
  tenantId: "t-1",
  subjectId: "sub-1",
  actionTaken: "activate",
  outcomeMetric: "open_rate",
  delta: 0.1,
  observedAt: new Date().toISOString(),
};

vi.mock("../../src/queue/recommendationStore", () => ({
  findRecommendationByCorrelation: vi.fn(),
}));

vi.mock("../../src/priors/tenantPriorStore", () => ({
  getTenantPrior: vi.fn().mockResolvedValue(null),
  putTenantPrior: vi.fn().mockResolvedValue(undefined),
}));

import { findRecommendationByCorrelation } from "../../src/queue/recommendationStore";
import { getTenantPrior, putTenantPrior } from "../../src/priors/tenantPriorStore";

const existingRec = { capability: "growth-next-action", actionType: "activate", confidence: 0.75, experimentId: null, arm: null };

function makeEnv(overrides: Partial<GrowthAgentEnv> = {}): GrowthAgentEnv {
  const bindPrepare = vi.fn().mockReturnValue({
    bind: vi.fn().mockReturnValue({
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({ success: true }),
      all: vi.fn().mockResolvedValue({ results: [] }),
    }),
  });
  return {
    OUTCOME_DB: { prepare: bindPrepare } as unknown as D1Database,
    ...overrides,
  } as unknown as GrowthAgentEnv;
}

describe("handleOutcomeFeedback", () => {
  it("rejects invalid payloads with VALIDATION_ERROR", async () => {
    const env = makeEnv();
    await expect(handleOutcomeFeedback({}, env, baseConfig)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects unknown correlationId with CORRELATION_NOT_FOUND", async () => {
    vi.mocked(findRecommendationByCorrelation).mockResolvedValue(null);
    const env = makeEnv();

    await expect(handleOutcomeFeedback(validPayload, env, baseConfig)).rejects.toMatchObject({
      code: "CORRELATION_NOT_FOUND",
    });
  });

  it("rejects duplicate outcomes with DUPLICATE_OUTCOME", async () => {
    vi.mocked(findRecommendationByCorrelation).mockResolvedValue(existingRec);

    const bindPrepare = vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ id: "existing-id" }),
        run: vi.fn().mockResolvedValue({ success: true }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      }),
    });
    const env = makeEnv({ OUTCOME_DB: { prepare: bindPrepare } as unknown as D1Database });

    await expect(handleOutcomeFeedback(validPayload, env, baseConfig)).rejects.toMatchObject({
      code: "DUPLICATE_OUTCOME",
    });
  });

  it("returns priorUpdated true on successful feedback", async () => {
    vi.mocked(findRecommendationByCorrelation).mockResolvedValue(existingRec);
    vi.mocked(getTenantPrior).mockResolvedValue(null);

    const env = makeEnv();
    const result = await handleOutcomeFeedback(validPayload, env, baseConfig);

    expect(result.priorUpdated).toBe(true);
    expect(putTenantPrior).toHaveBeenCalled();
  });
});