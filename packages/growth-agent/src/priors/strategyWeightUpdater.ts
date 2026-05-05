import type { TenantPrior } from "../types";

export interface StrategyUpdateInput {
  outcomeDelta: number;
  fallbackTriggered: boolean;
  observedTone?: string;
}

export function updateStrategyWeights(prior: TenantPrior, input: StrategyUpdateInput): TenantPrior {
  const next = structuredClone(prior);
  const weights = next.strategyWeights;

  if (input.outcomeDelta > 0 && input.observedTone) {
    weights.urgencyBias = clamp(weights.urgencyBias + 0.03, 0, 1);
    weights.toneVariance = clamp(weights.toneVariance + 0.02, 0.1, 0.7);
  }

  if (input.outcomeDelta <= 0) {
    weights.urgencyBias = clamp(weights.urgencyBias - 0.02, 0, 1);
    weights.toneVariance = clamp(weights.toneVariance - 0.01, 0.1, 0.7);
  }

  if (input.fallbackTriggered) {
    weights.conservatism = clamp(weights.conservatism + 0.05, 0, 1);
    weights.toneVariance = clamp(weights.toneVariance - 0.03, 0.1, 0.7);
  } else {
    weights.conservatism = clamp(weights.conservatism - 0.01, 0, 1);
  }

  next.updatedAt = new Date().toISOString();
  return next;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
