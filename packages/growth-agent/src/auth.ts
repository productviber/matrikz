import { UUID_V4_REGEX } from "@matrikz/growth-agent-contracts";
import { HEADER_NAMES, MAX_PAYLOAD_BYTES } from "./constants";
import { AppError } from "./errors";
import type { GrowthAgentEnv, RequestContext, RuntimeConfig } from "./types";

/*
Secret rotation runbook (v1)
1) Provision new secret as INTERNAL_SECRET and move old value to INTERNAL_SECRET_PREVIOUS.
2) Keep both active for INTERNAL_SECRET_ROTATION_WINDOW_HOURS (default 24h).
3) Monitor auth_failure_reason events and upstream success rates.
4) After window, remove INTERNAL_SECRET_PREVIOUS binding.
5) Never log secret values.
*/
export function requireInternalAuth(
  request: Request,
  env: GrowthAgentEnv,
  config: RuntimeConfig,
): RequestContext {
  const providedSecret = request.headers.get(HEADER_NAMES.internalSecret);
  const activeSecrets = [env.INTERNAL_SECRET, env.INTERNAL_SECRET_PREVIOUS].filter(
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

  if (env.INTERNAL_SECRET_PREVIOUS) {
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

  const expectedPrefix = `${tenantId}:`;
  if (!correlationId.startsWith(expectedPrefix)) {
    throw new AppError("VALIDATION_ERROR", "Invalid correlation id");
  }

  const uuidPart = correlationId.slice(expectedPrefix.length);
  if (!UUID_V4_REGEX.test(uuidPart)) {
    throw new AppError("VALIDATION_ERROR", "Invalid correlation id");
  }

  // Idempotency key is optional; if provided it MUST be a UUID v4 to ensure
  // safe downstream deduplication and prevent key-collision abuse.
  if (idempotencyKey !== null && !UUID_V4_REGEX.test(idempotencyKey)) {
    throw new AppError("VALIDATION_ERROR", "Invalid idempotency key format");
  }

  if (idempotencyKey) {
    console.log(
      JSON.stringify({
        type: "idempotency_key_received",
        correlationId,
        tenantId,
      }),
    );
  }

  return {
    correlationId,
    tenantId,
    idempotencyKeyPresent: Boolean(idempotencyKey),
    startedAt: Date.now(),
  };
}

export async function requireJsonBody<T>(request: Request, maxBytes = MAX_PAYLOAD_BYTES): Promise<T> {
  const contentType = request.headers.get(HEADER_NAMES.contentType) ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Invalid content type");
  }

  // Fast-path: reject before reading body when Content-Length is declared.
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number.parseInt(contentLength, 10) > maxBytes) {
    throw new AppError("VALIDATION_ERROR", "Payload too large");
  }

  // Read as text to enforce byte-level size bound before parsing.
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new AppError("VALIDATION_ERROR", "Invalid JSON body");
  }

  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new AppError("VALIDATION_ERROR", "Payload too large");
  }

  try {
    return JSON.parse(text) as T;
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
      correlationId: request.headers.get(HEADER_NAMES.correlationId) ?? "unknown",
      tenantId: request.headers.get(HEADER_NAMES.tenantId) ?? "unknown",
    }),
  );
}
