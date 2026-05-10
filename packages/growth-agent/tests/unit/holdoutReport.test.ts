import { describe, expect, it, vi } from "vitest";
import { buildHoldoutReport } from "../../src/reporting/holdoutReport";
import type { GrowthAgentEnv } from "../../src/types";

const holdoutRows = [
  {
    experimentId: "exp-agentic-1",
    arm: "control",
    capability: "growth-next-action",
    actionType: "activate",
    recommendations: 80,
    outcomes: 22,
    positiveOutcomes: 12,
    conversions: 4,
    totalDelta: 5,
    avgObservedDelta: 0.23,
  },
  {
    experimentId: "exp-agentic-1",
    arm: "treatment",
    capability: "growth-next-action",
    actionType: "activate",
    recommendations: 100,
    outcomes: 45,
    positiveOutcomes: 30,
    conversions: 10,
    totalDelta: 18,
    avgObservedDelta: 0.4,
  },
];

function makeOutcomeDb(rows = holdoutRows): D1Database {
  const all = vi.fn().mockResolvedValue({ results: rows });
  const bind = vi.fn().mockReturnValue({ all });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { prepare } as unknown as D1Database;
}

describe("buildHoldoutReport", () => {
  it("returns unavailable when outcome D1 is not configured", async () => {
    const report = await buildHoldoutReport({} as GrowthAgentEnv, { windowDays: 30 });

    expect(report.available).toBe(false);
    expect(report.reason).toBe("outcome_db_unavailable");
  });

  it("computes treatment-control uplift and confidence interval", async () => {
    const report = await buildHoldoutReport(
      { OUTCOME_DB: makeOutcomeDb() } as GrowthAgentEnv,
      { windowDays: 30, minArmSample: 50 },
    );

    expect(report.available).toBe(true);
    expect(report.comparisons).toHaveLength(1);
    const comparison = report.comparisons[0];
    expect(comparison.experimentId).toBe("exp-agentic-1");
    expect(comparison.treatment?.positiveOutcomeRate).toBeCloseTo(0.3, 5);
    expect(comparison.control?.positiveOutcomeRate).toBeCloseTo(0.15, 5);
    expect(comparison.uplift.positiveOutcomeRate).toBeCloseTo(0.15, 5);
    expect(comparison.uplift.conversionRate).toBeCloseTo(0.05, 5);
    expect(comparison.uplift.sampleSizeSufficient).toBe(true);
    expect(comparison.uplift.positiveOutcomeRateConfidenceInterval95).not.toBeNull();
  });
});