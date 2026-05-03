import { CORRELATION_ID_REGEX } from "@clodo/growth-agent-contracts";
import { HEADER_NAMES } from "./constants";
import { AppError } from "./errors";
import type { GrowthAgentEnv, RequestContext, RuntimeConfig } from "./types";

/*
Secret rotation runbook (v1)
1) Provision new secret as INTERNAL_SECRET and move old value to INTERNAL_SECRET_ROLLOVER.
2) Keep both active for INTERNAL_SECRET_ROTATION_WINDOW_HOURS (default 24h).
3) Monitor auth_failure_reason events and upstream success rates.
4) After window, remove INTERNAL_SECRET_ROLLOVER binding.
5) Never log secret values.
*/
export function requireInternalAuth(
  request: Request,
  env: GrowthAgentEnv,
  config: RuntimeConfig,
): RequestContext {
  const providedSecret = request.headers.get(HEADER_NAMES.internalSecret);
  const activeSecrets = [env.INTERNAL_SECRET, env.INTERNAL_SECRET_ROLLOVER].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );

  if (!providedSecret) {
    logAuthFailure("secret_missing", request);
    throw new AppError("UNAUTHORIZED", "Unauthorized");
  }

  if (!activeSecrets.length) {
    logAuthFailure("secret_missing", request);
    throw new AppError("UNAUTHORIZED", "Unauthorized");
  }

  const accepted = activeSecrets.some((secret) => timingSafeEqual(providedSecret, secret));
  if (!accepted) {
    logAuthFailure("secret_mismatch", request);
    throw new AppError("UNAUTHORIZED", "Unauthorized");
  }

  if (env.INTERNAL_SECRET_ROLLOVER) {
    console.log(
      JSON.stringify({
        type: "secret_rotation_window",
        windowHours: config.secretRotationWindowHours,
      }),
    );
  }

  const correlationId = request.headers.get(HEADER_NAMES.correlationId);
  const tenantId = request.headers.get(HEADER_NAMES.tenantId);
  const idempotencyKey = request.headers.get(HEADER_NAMES.idempotencyKey);

  if (!correlationId || !tenantId) {
    throw new AppError("VALIDATION_ERROR", "Invalid headers");
  }

  // Validate base36-timestamp + hyphen + base36-rand format produced by
  // getCorrelationId() in the marketer: `${ts.toString(36)}-${rand4}`
  if (!CORRELATION_ID_REGEX.test(correlationId)) {
    throw new AppError("VALIDATION_ERROR", "Invalid correlation id");
  }

  return {
    correlationId,
    tenantId,
    idempotencyKeyPresent: Boolean(idempotencyKey),
    startedAt: Date.now(),
  };
}

export async function requireJsonBody<T>(request: Request): Promise<T> {
  const contentType = request.headers.get(HEADER_NAMES.contentType) ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Invalid content type");
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new AppError("VALIDATION_ERROR", "Invalid JSON body");
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function logAuthFailure(reason: "secret_missing" | "secret_mismatch", request: Request): void {
  console.log(
    JSON.stringify({
      type: "auth_failure",
      auth_failure_reason: reason,
      correlationId: request.headers.get(HEADER_NAMES.correlationId),
      tenantId: request.headers.get(HEADER_NAMES.tenantId),
    }),
  );
}
