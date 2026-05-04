import { ROUTE_REASONS } from "./constants";
import type { ErrorEnvelope } from "@matrikz/growth-agent-contracts";
import type { CapabilityName, ErrorCode, Metadata, RuntimeConfig } from "./types";

const ERROR_POLICY: Record<ErrorCode, { status: number; retryable: boolean }> = {
  UNAUTHORIZED: { status: 401, retryable: false },
  VALIDATION_ERROR: { status: 400, retryable: false },
  UPSTREAM_TIMEOUT: { status: 504, retryable: true },
  UPSTREAM_FAILURE: { status: 502, retryable: true },
  UPSTREAM_QUOTA_EXCEEDED: { status: 429, retryable: false },
  BUDGET_EXHAUSTED: { status: 200, retryable: false },
  OUTPUT_SCHEMA_INVALID: { status: 200, retryable: true },
  CAPABILITY_DISABLED: { status: 503, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  INTERNAL_FALLBACK: { status: 200, retryable: true },
  INTERNAL_ERROR: { status: 500, retryable: false },
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = ERROR_POLICY[code].status;
    this.retryable = ERROR_POLICY[code].retryable;
  }
}

export function makeMetadata(
  capability: CapabilityName,
  correlationId: string,
  config: RuntimeConfig,
  overrides?: Partial<Metadata>,
): Metadata {
  return {
    provider: "workers-ai",
    model: config.model,
    capability,
    promptVersion: `${capability}-1.0.0`,
    requestSchemaVersion: config.requestSchemaVersion,
    responseSchemaVersion: config.responseSchemaVersion,
    correlationId,
    latencyMs: 0,
    tokenEstimate: 0,
    costEstimate: 0,
    fallback: false,
    routeReason: ROUTE_REASONS.predictive,
    error: null,
    ...overrides,
  };
}

export function toErrorEnvelope(
  error: AppError,
  metadata: Metadata,
  safeMessage = "The request could not be processed.",
): ErrorEnvelope {
  return {
    ok: false,
    error: {
      code: error.code,
      message: safeMessage,
      retryable: error.retryable,
    },
    metadata: {
      ...metadata,
      fallback: error.code !== "CAPABILITY_DISABLED",
      error: error.code,
    },
  };
}
