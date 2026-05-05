import type { GrowthSignal, TenantPrior } from "@clodo/growth-agent-contracts";
import { calibrateConfidenceFactor, type CalibrationSample } from "./confidenceCalibrator";

export interface PriorAccumulationInput {
  prior: TenantPrior | null;
  confidence: number;
  outcomeDelta: number;
  observedTone?: string;
  signals?: GrowthSignal[];
  calibrationHistory: CalibrationSample[];
}

export function accumulatePrior(input: PriorAccumulationInput): TenantPrior {
  const now = new Date().toISOString();
  const base: TenantPrior =
    input.prior ?? {
      preferredTone: "clear",
      avgConfidence: 0.5,
      topSignalWeights: [],
      lastOutcomeDelta: 0,
      interactionCount: 0,
      calibrationFactor: 1,
      consecutiveNegativeOutcomes: 0,
      strategyWeights: {
        toneVariance: 0.2,
        urgencyBias: 0.5,
        conservatism: 0.5,
      },
      updatedAt: now,
    };

  const interactionCount = base.interactionCount + 1;

  // Time-weighted alpha: older priors yield faster to new signal
  const staleDays = base.updatedAt
    ? (Date.now() - Date.parse(base.updatedAt)) / 86400000
    : 0;
  const alpha = clamp(0.3 + staleDays * 0.01, 0.3, 0.7);
  const avgConfidence = alpha * input.confidence + (1 - alpha) * base.avgConfidence;

  const tone = input.observedTone && input.outcomeDelta > 0 ? input.observedTone : base.preferredTone;

  const incomingSignalNames = new Set<string>((input.signals ?? []).map((s) => s.name));
  const signalWeights = new Map<string, number>(
    base.topSignalWeights.map((entry) => [entry.signal, entry.weight]),
  );

  // Decay weights for signals not present in this observation
  for (const [sig, w] of signalWeights.entries()) {
    if (!incomingSignalNames.has(sig)) {
      signalWeights.set(sig, clamp(w * 0.97, 0, 1));
    }
  }

  // Accumulate weights for observed signals
  for (const signal of input.signals ?? []) {
    const prev = signalWeights.get(signal.name) ?? 0.5;
    const outcomeImpact = input.outcomeDelta > 0 ? 0.05 : -0.03;
    signalWeights.set(signal.name, clamp(prev + outcomeImpact, 0, 1));
  }

  const topSignalWeights = [...signalWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([signal, weight]) => ({ signal, weight }));

  // Consecutive-negative counter
  const consecutiveNegativeOutcomes =
    input.outcomeDelta <= 0
      ? (base.consecutiveNegativeOutcomes ?? 0) + 1
      : 0;

  const calibrationFactor = calibrateConfidenceFactor(input.calibrationHistory);
  const negativeThreshold = 5;

  // Partial reset: signal weights zeroed, strategy weights reset to defaults
  // calibrationFactor is preserved so prior learning about confidence accuracy survives
  if (consecutiveNegativeOutcomes >= negativeThreshold) {
    console.log(
      JSON.stringify({
        type: "prior_partial_reset",
        tenantId: undefined,
        consecutiveNegativeOutcomes,
        threshold: negativeThreshold,
      }),
    );
    return {
      ...base,
      preferredTone: tone,
      avgConfidence: clamp(avgConfidence, 0, 1),
      topSignalWeights: [],
      lastOutcomeDelta: input.outcomeDelta,
      interactionCount,
      calibrationFactor,
      consecutiveNegativeOutcomes: 0,
      strategyWeights: {
        toneVariance: 0.2,
        urgencyBias: 0.5,
        conservatism: 0.5,
      },
      updatedAt: now,
    };
  }

  return {
    ...base,
    preferredTone: tone,
    avgConfidence: clamp(avgConfidence, 0, 1),
    topSignalWeights,
    lastOutcomeDelta: input.outcomeDelta,
    interactionCount,
    calibrationFactor,
    consecutiveNegativeOutcomes,
    updatedAt: now,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
