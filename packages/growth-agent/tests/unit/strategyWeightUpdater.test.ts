import { describe, expect, it } from "vitest";
import { updateStrategyWeights } from "../../src/priors/strategyWeightUpdater";
import type { TenantPrior } from "../../src/types";

const basePrior: TenantPrior = {
  preferredTone: "clear",
  avgConfidence: 0.6,
  topSignalWeights: [],
  lastOutcomeDelta: 0,
  interactionCount: 5,
  calibrationFactor: 1,
  consecutiveNegativeOutcomes: 0,
  strategyWeights: {
    toneVariance: 0.2,
    urgencyBias: 0.5,
    conservatism: 0.5,
  },
  updatedAt: new Date().toISOString(),
};

describe("updateStrategyWeights", () => {
  it("increases urgencyBias and toneVariance on positive outcome with tone", () => {
    const result = updateStrategyWeights(basePrior, {
      outcomeDelta: 1,
      fallbackTriggered: false,
      observedTone: "urgent",
    });
    expect(result.strategyWeights.urgencyBias).toBeCloseTo(0.53, 5);
    expect(result.strategyWeights.toneVariance).toBeCloseTo(0.22, 5);
    expect(result.strategyWeights.conservatism).toBeCloseTo(0.49, 5);
  });

  it("decreases urgencyBias and toneVariance on negative outcome", () => {
    const result = updateStrategyWeights(basePrior, {
      outcomeDelta: -1,
      fallbackTriggered: false,
    });
    expect(result.strategyWeights.urgencyBias).toBeCloseTo(0.48, 5);
    expect(result.strategyWeights.toneVariance).toBeCloseTo(0.19, 5);
  });

  it("increases conservatism and reduces toneVariance when fallback triggered", () => {
    const result = updateStrategyWeights(basePrior, {
      outcomeDelta: 0,
      fallbackTriggered: true,
    });
    expect(result.strategyWeights.conservatism).toBeCloseTo(0.55, 5);
    expect(result.strategyWeights.toneVariance).toBeCloseTo(0.16, 5);
  });

  it("does not mutate the original prior", () => {
    const original = JSON.stringify(basePrior);
    updateStrategyWeights(basePrior, { outcomeDelta: 1, fallbackTriggered: false });
    expect(JSON.stringify(basePrior)).toBe(original);
  });

  it("clamps all weights within valid bounds", () => {
    const at_max: TenantPrior = {
      ...basePrior,
      strategyWeights: { toneVariance: 0.7, urgencyBias: 1.0, conservatism: 1.0 },
    };
    const result = updateStrategyWeights(at_max, {
      outcomeDelta: 1,
      fallbackTriggered: true,
      observedTone: "urgent",
    });
    expect(result.strategyWeights.urgencyBias).toBeLessThanOrEqual(1);
    expect(result.strategyWeights.conservatism).toBeLessThanOrEqual(1);
    expect(result.strategyWeights.toneVariance).toBeGreaterThanOrEqual(0.1);
    expect(result.strategyWeights.toneVariance).toBeLessThanOrEqual(0.7);
  });

  it("updates the updatedAt timestamp", () => {
    const before = basePrior.updatedAt;
    const result = updateStrategyWeights(basePrior, { outcomeDelta: 0, fallbackTriggered: false });
    expect(result.updatedAt).not.toBe(before);
  });
});
