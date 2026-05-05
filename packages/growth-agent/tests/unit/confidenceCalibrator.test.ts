import { describe, expect, it } from "vitest";
import {
  calibrateConfidenceFactor,
  applyCalibratedConfidence,
} from "../../src/priors/confidenceCalibrator";

describe("calibrateConfidenceFactor", () => {
  it("returns 1 (neutral) when there are no samples (cold start)", () => {
    expect(calibrateConfidenceFactor([])).toBe(1);
  });

  it("returns factor < 1 when the model is consistently overconfident", () => {
    // Predicted high, all outcomes negative
    const samples = Array.from({ length: 5 }, () => ({
      predictedConfidence: 0.9,
      observedDelta: -1,
    }));
    const factor = calibrateConfidenceFactor(samples);
    expect(factor).toBeLessThan(1);
    expect(factor).toBeGreaterThanOrEqual(0.5);
  });

  it("returns factor > 1 when the model is consistently underconfident", () => {
    // Predicted low, all outcomes positive
    const samples = Array.from({ length: 5 }, () => ({
      predictedConfidence: 0.1,
      observedDelta: 1,
    }));
    const factor = calibrateConfidenceFactor(samples);
    expect(factor).toBeGreaterThan(1);
    expect(factor).toBeLessThanOrEqual(1.5);
  });

  it("returns factor near 1 when predictions are well-calibrated", () => {
    // Predicted 0.8 and outcomes positive, predicted 0.2 and outcomes negative
    const samples = [
      { predictedConfidence: 0.8, observedDelta: 1 },
      { predictedConfidence: 0.8, observedDelta: 1 },
      { predictedConfidence: 0.2, observedDelta: -1 },
      { predictedConfidence: 0.2, observedDelta: -1 },
    ];
    const factor = calibrateConfidenceFactor(samples);
    expect(factor).toBeCloseTo(1, 1);
  });

  it("always clamps output to [0.5, 1.5]", () => {
    const extremeOver = Array.from({ length: 20 }, () => ({
      predictedConfidence: 1.0,
      observedDelta: -100,
    }));
    expect(calibrateConfidenceFactor(extremeOver)).toBeGreaterThanOrEqual(0.5);

    const extremeUnder = Array.from({ length: 20 }, () => ({
      predictedConfidence: 0.0,
      observedDelta: 100,
    }));
    expect(calibrateConfidenceFactor(extremeUnder)).toBeLessThanOrEqual(1.5);
  });
});

describe("applyCalibratedConfidence", () => {
  it("scales confidence by the calibration factor", () => {
    expect(applyCalibratedConfidence(0.8, 0.9)).toBeCloseTo(0.72);
  });

  it("clamps the result to [0, 1]", () => {
    expect(applyCalibratedConfidence(0.9, 1.5)).toBeLessThanOrEqual(1);
    expect(applyCalibratedConfidence(0.1, 0.0)).toBeGreaterThanOrEqual(0);
  });
});
