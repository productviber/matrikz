import { describe, expect, it } from "vitest";
import { accumulatePrior } from "../../src/priors/priorAccumulator";
import type { TenantPrior } from "../../src/types";

const basePrior: TenantPrior = {
  preferredTone: "clear",
  avgConfidence: 0.6,
  topSignalWeights: [{ signal: "engagement", weight: 0.7 }],
  lastOutcomeDelta: 0,
  interactionCount: 5,
  calibrationFactor: 1,
  consecutiveNegativeOutcomes: 0,
  strategyWeights: { toneVariance: 0.2, urgencyBias: 0.5, conservatism: 0.5 },
  updatedAt: new Date().toISOString(),
};

describe("accumulatePrior", () => {
  it("bootstraps a new prior when none exists (cold start)", () => {
    const result = accumulatePrior({
      prior: null,
      confidence: 0.8,
      outcomeDelta: 1,
      calibrationHistory: [],
    });
    expect(result.interactionCount).toBe(1);
    expect(result.avgConfidence).toBeGreaterThan(0.5);
  });

  it("increments interactionCount on each accumulation", () => {
    const result = accumulatePrior({
      prior: basePrior,
      confidence: 0.7,
      outcomeDelta: 1,
      calibrationHistory: [],
    });
    expect(result.interactionCount).toBe(6);
  });

  it("applies EMA (α=0.3) to avgConfidence", () => {
    const result = accumulatePrior({
      prior: basePrior, // avgConfidence: 0.6
      confidence: 1.0,
      outcomeDelta: 1,
      calibrationHistory: [],
    });
    // 0.3 * 1.0 + 0.7 * 0.6 = 0.72
    expect(result.avgConfidence).toBeCloseTo(0.72, 5);
  });

  it("updates preferredTone when outcome is positive and tone provided", () => {
    const result = accumulatePrior({
      prior: basePrior,
      confidence: 0.7,
      outcomeDelta: 1,
      observedTone: "urgent",
      calibrationHistory: [],
    });
    expect(result.preferredTone).toBe("urgent");
  });

  it("retains existing preferredTone when outcome is negative", () => {
    const result = accumulatePrior({
      prior: basePrior,
      confidence: 0.7,
      outcomeDelta: -1,
      observedTone: "urgent",
      calibrationHistory: [],
    });
    expect(result.preferredTone).toBe("clear");
  });

  it("increases signal weight for positive outcomes", () => {
    const result = accumulatePrior({
      prior: basePrior,
      confidence: 0.7,
      outcomeDelta: 1,
      signals: [{ name: "engagement", kind: "number", value: 0.5 }],
      calibrationHistory: [],
    });
    const openRate = result.topSignalWeights.find((s) => s.signal === "engagement");
    expect(openRate?.weight).toBeGreaterThan(0.7);
  });

  it("decreases signal weight for negative outcomes", () => {
    const result = accumulatePrior({
      prior: basePrior,
      confidence: 0.7,
      outcomeDelta: -1,
      signals: [{ name: "engagement", kind: "number", value: 0.5 }],
      calibrationHistory: [],
    });
    const openRate = result.topSignalWeights.find((s) => s.signal === "engagement");
    expect(openRate?.weight).toBeLessThan(0.7);
  });

  it("limits topSignalWeights to 8 entries sorted by weight descending", () => {
    const manySignals: TenantPrior = {
      ...basePrior,
      topSignalWeights: Array.from({ length: 12 }, (_, i) => ({
        signal: `sig_${i}`,
        weight: i * 0.05,
      })),
    };
    const result = accumulatePrior({
      prior: manySignals,
      confidence: 0.5,
      outcomeDelta: 0,
      calibrationHistory: [],
    });
    expect(result.topSignalWeights.length).toBeLessThanOrEqual(8);
    // First entry should have the highest weight
    expect(result.topSignalWeights[0].weight).toBeGreaterThanOrEqual(
      result.topSignalWeights[result.topSignalWeights.length - 1].weight,
    );
  });

  it("uses calibration history to set calibrationFactor", () => {
    const overconfidentHistory = Array.from({ length: 5 }, () => ({
      predictedConfidence: 0.9,
      observedDelta: -1,
    }));
    const result = accumulatePrior({
      prior: basePrior,
      confidence: 0.7,
      outcomeDelta: 0,
      calibrationHistory: overconfidentHistory,
    });
    expect(result.calibrationFactor).toBeLessThan(1);
  });
});
