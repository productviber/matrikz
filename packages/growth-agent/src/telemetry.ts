import type { CapabilityName, ErrorCode, RequestContext } from "./types";

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

export function emitTelemetry(event: TelemetryEvent): void {
  // Keep payload structured and PII-safe; no raw prompts or user messages are logged.
  console.log(JSON.stringify({ type: "growth_agent_request", ...event }));
}

export function baseTelemetry(
  ctx: RequestContext,
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
