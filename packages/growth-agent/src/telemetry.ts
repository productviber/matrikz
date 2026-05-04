import { LATENCY_HISTOGRAM_BUCKETS, SLO_TARGETS } from "./constants";
import type { CapabilityName, ErrorCode } from "./types";

export interface TelemetryEvent {
  correlationId: string;
  tenantId: string;
  capability: CapabilityName;
  idempotencyKeyPresent?: boolean;
  latencyMs: number;
  provider: string;
  model: string;
  schemaValid: boolean;
  fallback: boolean;
  errorCode: ErrorCode | null;
  requestSchemaVersion: string;
  responseSchemaVersion: string;
}

/**
 * Bucket a latency measurement into a histogram slot aligned with SLO boundaries.
 * Keeps dashboards consistent without requiring the caller to know bucket edges.
 */
function resolveLatencyBucket(ms: number): string {
  for (const bound of LATENCY_HISTOGRAM_BUCKETS) {
    if (ms <= bound) {
      return `<=${bound}ms`;
    }
  }
  return `>${LATENCY_HISTOGRAM_BUCKETS[LATENCY_HISTOGRAM_BUCKETS.length - 1]}ms`;
}

export function emitTelemetry(event: TelemetryEvent): void {
  // Keep payload structured and PII-safe; no raw prompts or user messages are logged.
  const latencyBucket = resolveLatencyBucket(event.latencyMs);
  console.log(JSON.stringify({ type: "growth_agent_request", ...event, latencyBucket }));

  // Emit a separate SLO breach warning when a live (non-fallback) request exceeds
  // the warm p99 latency target. Enables threshold alerting without log parsing.
  if (!event.fallback && event.latencyMs > SLO_TARGETS.latencyP99Ms.warm) {
    console.log(
      JSON.stringify({
        type: "slo_breach_warning",
        capability: event.capability,
        correlationId: event.correlationId,
        latencyMs: event.latencyMs,
        latencyBucket,
        sloThresholdMs: SLO_TARGETS.latencyP99Ms.warm,
      }),
    );
  }
}

export function baseTelemetry(
  ctx: { correlationId: string; tenantId: string },
  capability: CapabilityName,
  requestSchemaVersion: string,
  responseSchemaVersion: string,
) {
  return {
    correlationId: ctx.correlationId,
    tenantId: ctx.tenantId,
    capability,
    requestSchemaVersion,
    responseSchemaVersion,
  };
}
