export interface CalibrationSample {
  predictedConfidence: number;
  observedDelta: number;
}

export function calibrateConfidenceFactor(samples: CalibrationSample[]): number {
  if (!samples.length) {
    return 1;
  }

  const bounded = samples.map((sample) => {
    const predicted = clamp(sample.predictedConfidence, 0, 1);
    const actual = sample.observedDelta > 0 ? 1 : 0;
    return { predicted, actual };
  });

  const brierScore =
    bounded.reduce((acc, sample) => acc + (sample.predicted - sample.actual) ** 2, 0) /
    bounded.length;

  const meanPredicted = bounded.reduce((acc, sample) => acc + sample.predicted, 0) / bounded.length;
  const meanActual = bounded.reduce((acc, sample) => acc + sample.actual, 0) / bounded.length;

  let factor = 1;
  if (brierScore > 0.25 && meanPredicted > meanActual) {
    factor = 0.9;
  } else if (brierScore > 0.25 && meanPredicted < meanActual) {
    factor = 1.1;
  } else if (meanPredicted > meanActual + 0.1) {
    factor = 0.95;
  } else if (meanPredicted + 0.1 < meanActual) {
    factor = 1.05;
  }

  return clamp(factor, 0.5, 1.5);
}

export function applyCalibratedConfidence(confidence: number, calibrationFactor: number): number {
  return clamp(confidence * calibrationFactor, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
