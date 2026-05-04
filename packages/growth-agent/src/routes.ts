import { requireInternalAuth, requireJsonBody } from "./auth";
import {
  CAPABILITY_NAMES,
  CAPABILITY_PATHS,
  DEFAULTS,
  MODEL_COST_PER_1K_TOKENS_USD,
  ROUTE_REASONS,
  SLO_TARGETS,
} from "./constants";
import { degradedResponseFor } from "./degraded";
import { AppError, makeMetadata, toErrorEnvelope } from "./errors";
import { FailOpenBudgetGuard, InMemoryBudgetGuard, InMemoryRateLimitGuard } from "./guards";
import { WorkersAiAdapter } from "./llm/workersAiAdapter";
import { emitTelemetry } from "./telemetry";
import type {
  CapabilityEnvelope,
  CapabilityName,
  GrowthAgentEnv,
  RequestContext,
  RouteReason,
  RuntimeConfig,
  TenantBudgetGuard,
  TenantRateLimitGuard,
} from "./types";
import { getRuntimeConfig } from "./types";
import { handleGrowthNextAction } from "./capabilities/growthNextAction";
import { handleGrowthSignalSummarize } from "./capabilities/growthSignalSummarize";
import { handleJourneyCritic } from "./capabilities/journeyCritic";
import { handleMessageBrief } from "./capabilities/messageBrief";
import { handleOutcomeDiagnose } from "./capabilities/outcomeDiagnose";

const rolloutCapabilityLog = new Set<CapabilityName>();

export async function handleRequest(request: Request, env: GrowthAgentEnv): Promise<Response> {
  const url = new URL(request.url);
  const config = getRuntimeConfig(env);

  if (request.method === "GET" && url.pathname === "/health") {
    return json(
      {
        ok: true,
        data: {
          status: "ok",
          version: config.appVersion,
        },
      },
      200,
    );
  }

  if (request.method === "GET" && url.pathname === "/internal/capabilities") {
    try {
      const authContext = requireInternalAuth(request, env, config);
      return json(
        {
          ok: true,
          data: {
            requestSchemaVersion: config.requestSchemaVersion,
            responseSchemaVersion: config.responseSchemaVersion,
            idempotency: "non-idempotent-v1",
            capabilities: Object.values(CAPABILITY_NAMES).map((name) => ({
              name,
              path: `/internal/${name}`,
              enabled: config.featureFlags[name],
              promptVersion: `${name}-1.0.0`,
              responseSchemaVersion: config.responseSchemaVersion,
              correlationId: authContext.correlationId,
            })),
          },
        },
        200,
      );
    } catch (error) {
      const appError = normalizeError(error);
      return json(
        { ok: false, error: { code: appError.code, message: safeMessage(appError.code), retryable: appError.retryable } },
        appError.status,
      );
    }
  }

  if (request.method !== "POST" || !url.pathname.startsWith("/internal/")) {
    return json({ ok: false, error: { code: "INTERNAL_ERROR", message: "Not found", retryable: false } }, 404);
  }

  const capability = CAPABILITY_NAMES[url.pathname as keyof typeof CAPABILITY_NAMES];
  if (!capability) {
    return json({ ok: false, error: { code: "INTERNAL_ERROR", message: "Not found", retryable: false } }, 404);
  }

  let context: RequestContext;
  try {
    context = requireInternalAuth(request, env, config);
  } catch (error) {
    const authError = normalizeError(error);
    const metadata = makeMetadata(capability, "unknown", config, {
      latencyMs: 0,
      fallback: true,
      routeReason: ROUTE_REASONS.fallback,
      error: authError.code,
    });
    return json(
      {
        ok: false,
        error: { code: authError.code, message: safeMessage(authError.code), retryable: authError.retryable },
        metadata,
      },
      authError.status,
    );
  }

  const llm = new WorkersAiAdapter(env);
  const budgetGuard: TenantBudgetGuard = new FailOpenBudgetGuard(
    new InMemoryBudgetGuard(config.budgetPerTenantPerMinute),
  );
  const rateGuard: TenantRateLimitGuard = new InMemoryRateLimitGuard(
    config.rateLimitPerTenantCapabilityPerMinute,
  );
  const metadata = makeMetadata(capability, context.correlationId, config);

  try {
    logRolloutGate(capability, config);

    if (!config.featureFlags[capability]) {
      throw new AppError("CAPABILITY_DISABLED", "Capability disabled");
    }

    const body = await requireJsonBody<unknown>(request);
    const tenantId = context.tenantId;

    const rateLimit = rateGuard.consume(tenantId, capability);
    if (!rateLimit.allowed) {
      throw new AppError("RATE_LIMITED", "Rate limit hit");
    }

    const budget = budgetGuard.consume(tenantId, capability);
    if (!budget.allowed) {
      return json(
        successDegradedEnvelope(
          capability,
          body,
          "BUDGET_EXHAUSTED",
          ROUTE_REASONS.tierDegraded,
          metadata,
          context,
          config,
        ),
        200,
      );
    }

    const result = await dispatchCapability(capability, body, { llm, config });

    const responseEnvelope: CapabilityEnvelope<unknown> = {
      ok: true,
      data: result.data,
      metadata: {
        ...metadata,
        promptVersion: result.promptVersion,
        latencyMs: Date.now() - context.startedAt,
        tokenEstimate: result.tokenEstimate,
        costEstimate: estimateCost(result.tokenEstimate, config.model),
        fallback: result.fallback,
        routeReason: result.routeReason,
        error: null,
      },
    };

    emitTelemetry({
      correlationId: context.correlationId,
      tenantId,
      capability,
      idempotencyKeyPresent: context.idempotencyKeyPresent,
      latencyMs: responseEnvelope.metadata.latencyMs,
      provider: responseEnvelope.metadata.provider,
      model: responseEnvelope.metadata.model,
      schemaValid: true,
      fallback: responseEnvelope.metadata.fallback,
      errorCode: null,
      requestSchemaVersion: config.requestSchemaVersion,
      responseSchemaVersion: config.responseSchemaVersion,
    });

    return json(responseEnvelope, 200);
  } catch (error) {
    const appError = normalizeError(error);

    if (
      appError.code === "UPSTREAM_QUOTA_EXCEEDED" ||
      appError.code === "OUTPUT_SCHEMA_INVALID"
    ) {
      const body = await safeReadBody(request);
      return json(
        successDegradedEnvelope(
          capability,
          body,
          appError.code,
          ROUTE_REASONS.fallback,
          metadata,
          context,
          config,
        ),
        appError.status,
        appError.code === "UPSTREAM_QUOTA_EXCEEDED" ? { "retry-after": "300" } : undefined,
      );
    }

    const errorEnvelope = toErrorEnvelope(
      appError,
      {
        ...metadata,
        latencyMs: Date.now() - context.startedAt,
        routeReason: appError.code === "RATE_LIMITED" ? ROUTE_REASONS.rateLimited : ROUTE_REASONS.fallback,
      },
      safeMessage(appError.code),
    );

    emitTelemetry({
      correlationId: context.correlationId,
      tenantId: context.tenantId,
      capability,
      idempotencyKeyPresent: context.idempotencyKeyPresent,
      latencyMs: errorEnvelope.metadata.latencyMs,
      provider: errorEnvelope.metadata.provider,
      model: errorEnvelope.metadata.model,
      schemaValid: false,
      fallback: errorEnvelope.metadata.fallback,
      errorCode: errorEnvelope.error.code,
      requestSchemaVersion: config.requestSchemaVersion,
      responseSchemaVersion: config.responseSchemaVersion,
    });

    const extraHeaders: Record<string, string> = {};
    if (appError.code === "CAPABILITY_DISABLED" || appError.code === "RATE_LIMITED") {
      extraHeaders["retry-after"] = String(DEFAULTS.retryAfterSeconds);
    }

    return json(errorEnvelope, appError.status, extraHeaders);
  }
}

function successDegradedEnvelope(
  capability: CapabilityName,
  input: unknown,
  code: "UPSTREAM_QUOTA_EXCEEDED" | "BUDGET_EXHAUSTED" | "OUTPUT_SCHEMA_INVALID",
  routeReason: RouteReason,
  metadataBase: CapabilityEnvelope<unknown>["metadata"],
  context: RequestContext,
  config: RuntimeConfig,
): CapabilityEnvelope<unknown> {
  const data = degradedResponseFor(capability, input, code.toLowerCase());
  const latencyMs = Date.now() - context.startedAt;
  emitTelemetry({
    correlationId: context.correlationId,
    tenantId: context.tenantId,
    capability,
    idempotencyKeyPresent: context.idempotencyKeyPresent,
    latencyMs,
    provider: "deterministic",
    model: "fallback",
    schemaValid: true,
    fallback: true,
    errorCode: code,
    requestSchemaVersion: config.requestSchemaVersion,
    responseSchemaVersion: config.responseSchemaVersion,
  });

  return {
    ok: true,
    data,
    metadata: {
      ...metadataBase,
      provider: "deterministic",
      model: "fallback",
      latencyMs,
      tokenEstimate: 0,
      costEstimate: 0,
      fallback: true,
      routeReason,
      error: code,
    },
  };
}

async function dispatchCapability(
  capability: CapabilityName,
  body: unknown,
  deps: {
    llm: WorkersAiAdapter;
    config: RuntimeConfig;
  },
): Promise<{ data: unknown; fallback: boolean; routeReason: RouteReason; tokenEstimate: number; promptVersion: string }> {
  switch (capability) {
    case "growth-next-action":
      return handleGrowthNextAction(body, deps);
    case "growth-signal-summarize":
      return handleGrowthSignalSummarize(body, deps);
    case "journey-critic":
      return handleJourneyCritic(body, deps);
    case "message-brief":
      return handleMessageBrief(body, deps);
    case "outcome-diagnose":
      return handleOutcomeDiagnose(body, deps);
    default:
      throw new AppError("INTERNAL_ERROR", "Unsupported capability");
  }
}

function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  if (error instanceof Error && error.message === "VALIDATION_ERROR") {
    return new AppError("VALIDATION_ERROR", "Validation error");
  }
  return new AppError("INTERNAL_ERROR", "Internal error");
}

function safeMessage(code: string): string {
  switch (code) {
    case "UNAUTHORIZED":
      return "Unauthorized";
    case "VALIDATION_ERROR":
      return "Invalid request";
    case "UPSTREAM_TIMEOUT":
      return "Upstream timeout";
    case "UPSTREAM_FAILURE":
      return "Upstream failure";
    case "UPSTREAM_QUOTA_EXCEEDED":
      return "Upstream quota exceeded";
    case "CAPABILITY_DISABLED":
      return "Capability temporarily disabled";
    case "RATE_LIMITED":
      return "Rate limit reached";
    default:
      return "Internal error";
  }
}

function estimateCost(tokens: number, model: string): number {
  const per1k = MODEL_COST_PER_1K_TOKENS_USD[model] ?? 0;
  return Number(((tokens / 1000) * per1k).toFixed(6));
}

function json(payload: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...extraHeaders,
    },
  });
}

function logRolloutGate(capability: CapabilityName, config: RuntimeConfig): void {
  if (rolloutCapabilityLog.has(capability)) {
    return;
  }
  rolloutCapabilityLog.add(capability);
  console.log(
    JSON.stringify({
      type: "rollout_gate_check",
      capability,
      pass: true,
      windowMinutes: SLO_TARGETS.rolloutGateWindowMinutes,
      thresholds: SLO_TARGETS,
      responseSchemaVersion: config.responseSchemaVersion,
      requestSchemaVersion: config.requestSchemaVersion,
    }),
  );
}

async function safeReadBody(request: Request): Promise<unknown> {
  try {
    return await request.clone().json();
  } catch {
    return {};
  }
}
