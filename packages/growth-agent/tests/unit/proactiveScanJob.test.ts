import { describe, expect, it, vi } from "vitest";
import { runProactiveScanJob } from "../../src/proactiveScan/proactiveScanJob";
import type { GrowthAgentEnv, RuntimeConfig } from "../../src/types";
import type { TenantSubject, PendingRecommendation } from "../../src/types";

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
  proactiveScanEnabled: true,
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

function makeSubject(id: string): TenantSubject {
  return {
    tenantId: "t-1",
    subjectId: id,
    staleSince: new Date(Date.now() - 86400 * 1000).toISOString(),
    signals: [{ name: "engagement", kind: "number", value: 0.9 }],
  };
}

function makeRecommendation(subjectId: string): PendingRecommendation {
  return {
    correlationId: `corr-${subjectId}`,
    tenantId: "t-1",
    subjectId,
    capability: "growth-next-action",
    action: { type: "activate", params: {}, reason: "high engagement" },
    confidence: 0.8,
    riskLevel: "low",
    sourcePromptVersion: "growth-next-action-1.0.0",
    enqueuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400 * 1000).toISOString(),
  };
}

vi.mock("../../src/proactiveScan/tenantRegistryClient", () => ({
  listStaleTenantSubjects: vi.fn(),
  markSubjectScanned: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/proactiveScan/subjectScanner", () => ({
  scanSubjectForRecommendation: vi.fn(),
}));

vi.mock("../../src/queue/recommendationQueueProducer", () => ({
  enqueueRecommendation: vi.fn().mockResolvedValue({ enqueued: true }),
}));

import { listStaleTenantSubjects, markSubjectScanned } from "../../src/proactiveScan/tenantRegistryClient";
import { scanSubjectForRecommendation } from "../../src/proactiveScan/subjectScanner";
import { enqueueRecommendation } from "../../src/queue/recommendationQueueProducer";

const mockEnv = {} as GrowthAgentEnv;
const mockLlm = { generateJson: vi.fn() } as unknown as import("../../src/types").LlmAdapter;

describe("runProactiveScanJob", () => {
  it("returns zero counts when no stale subjects", async () => {
    vi.mocked(listStaleTenantSubjects).mockResolvedValue([]);

    const result = await runProactiveScanJob(mockEnv, { llm: mockLlm, config: baseConfig });

    expect(result.scanned).toBe(0);
    expect(result.queued).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("scans and enqueues recommendations for stale subjects", async () => {
    const subjects = [makeSubject("sub-1"), makeSubject("sub-2")];
    vi.mocked(listStaleTenantSubjects).mockResolvedValue(subjects);
    vi.mocked(scanSubjectForRecommendation).mockImplementation(async (s) => makeRecommendation(s.subjectId));

    const result = await runProactiveScanJob(mockEnv, { llm: mockLlm, config: baseConfig });

    expect(result.scanned).toBe(2);
    expect(result.queued).toBe(2);
    expect(result.failed).toBe(0);
    expect(enqueueRecommendation).toHaveBeenCalledTimes(2);
    expect(markSubjectScanned).toHaveBeenCalledTimes(2);
  });

  it("skips enqueue when scanner returns null", async () => {
    vi.mocked(listStaleTenantSubjects).mockResolvedValue([makeSubject("sub-3")]);
    vi.mocked(scanSubjectForRecommendation).mockResolvedValue(null);
    vi.mocked(enqueueRecommendation).mockClear();

    const result = await runProactiveScanJob(mockEnv, { llm: mockLlm, config: baseConfig });

    expect(result.scanned).toBe(1);
    expect(result.queued).toBe(0);
    expect(enqueueRecommendation).not.toHaveBeenCalled();
  });

  it("stops enqueueing after reaching proactiveScanBatchSize", async () => {
    const batchConfig = { ...baseConfig, proactiveScanBatchSize: 2 };
    const subjects = Array.from({ length: 5 }, (_, i) => makeSubject(`sub-batch-${i}`));
    vi.mocked(listStaleTenantSubjects).mockResolvedValue(subjects);
    vi.mocked(scanSubjectForRecommendation).mockImplementation(async (s) =>
      makeRecommendation(s.subjectId),
    );

    const result = await runProactiveScanJob(mockEnv, { llm: mockLlm, config: batchConfig });

    expect(result.queued).toBe(2);
    expect(result.batchLimitReached).toBe(true);
    expect(result.scanned).toBeLessThan(5);
  });
});