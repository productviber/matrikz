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
import { FetchLlmAdapter } from "./llm/fetchLlmAdapter";
import { FailoverLlmAdapter } from "./llm/failoverLlmAdapter";
import { emitTelemetry } from "./telemetry";
import type {
  CapabilityEnvelope,
  CapabilityName,
  GrowthAgentEnv,
  LlmAdapter,
  Metadata,
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
import { handleOutcomeFeedback } from "./capabilities/outcomeFeedback";
import { getTenantPrior } from "./priors/tenantPriorStore";
import { saveRecommendation } from "./queue/recommendationStore";
import { buildHoldoutReport } from "./reporting/holdoutReport";

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
            capabilities: [
              ...Object.values(CAPABILITY_NAMES).map((name) => ({
                name,
                path: `/internal/${name}`,
                enabled: config.featureFlags[name],
                promptVersion: `${name}-1.0.0`,
                responseSchemaVersion: config.responseSchemaVersion,
                correlationId: authContext.correlationId,
              })),
              {
                name: "outcome-feedback",
                path: CAPABILITY_PATHS.outcomeFeedback,
                enabled: (env.CAPABILITY_OUTCOME_FEEDBACK_ENABLED ?? "true").toLowerCase() === "true",
                promptVersion: "outcome-feedback-1.0.0",
                responseSchemaVersion: config.responseSchemaVersion,
                correlationId: authContext.correlationId,
              },
            ],
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

  if (request.method === "GET" && url.pathname === "/internal/experiments/holdout-report") {
    return handleHoldoutReportRoute(request, env, config);
  }

  if (request.method !== "POST" || !url.pathname.startsWith("/internal/")) {
    return json({ ok: false, error: { code: "INTERNAL_ERROR", message: "Not found", retryable: false } }, 404);
  }

  if (url.pathname === CAPABILITY_PATHS.outcomeFeedback) {
    return handleOutcomeFeedbackRoute(request, env, config);
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

  const llm = createLlmAdapter(env);
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

    const tenantPrior = await getTenantPrior(env, tenantId);
    const result = await dispatchCapability(capability, body, { llm, config, tenantPrior });

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

    if (
      capability === "growth-next-action" &&
      !result.fallback &&
      typeof result.data === "object" &&
      result.data !== null
    ) {
      const d = result.data as {
        action?: { type?: string; params?: Record<string, unknown>; reason?: string };
        confidence?: number;
        riskLevel?: string;
      };
      const subjectId = (body as { subjectId?: unknown }).subjectId as string | undefined;
      if (
        d.action?.type &&
        d.action.type !== "wait" &&
        subjectId &&
        d.confidence !== undefined &&
        d.riskLevel
      ) {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
        void saveRecommendation(
          env,
          {
            tenantId,
            subjectId,
            capability: "growth-next-action",
            action: {
              type: d.action.type as import("@clodo/growth-agent-contracts").ActionType,
              params: d.action.params ?? {},
              reason: d.action.reason ?? "",
            },
            confidence: d.confidence,
            riskLevel: d.riskLevel as "low" | "medium" | "high" | "critical",
            correlationId: context.correlationId,
            sourcePromptVersion: result.promptVersion,
            enqueuedAt: now.toISOString(),
            expiresAt,
          },
          "reactive",
        ).catch((err: unknown) => {
          console.log(JSON.stringify({ type: "recommendation_save_error", error: err instanceof Error ? err.message : "unknown", correlationId: context.correlationId }));
        });
      }
    }

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
  deps: { llm: LlmAdapter; config: RuntimeConfig; tenantPrior?: Awaited<ReturnType<typeof getTenantPrior>> },
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

function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error && error.message === "VALIDATION_ERROR") {
    return new AppError("VALIDATION_ERROR", error.message);
  }
  return new AppError("INTERNAL_ERROR", "Unexpected error");
}

async function handleOutcomeFeedbackRoute(
  request: Request,
  env: GrowthAgentEnv,
  config: RuntimeConfig,
): Promise<Response> {
  const startedAt = Date.now();
  try {
    const context = requireInternalAuth(request, env, config);
    if ((env.CAPABILITY_OUTCOME_FEEDBACK_ENABLED ?? "true").toLowerCase() !== "true") {
      throw new AppError("CAPABILITY_DISABLED", "Outcome feedback disabled");
    }
    const body = await requireJsonBody<unknown>(request);
    const data = await handleOutcomeFeedback(body, env, config);

    return json(
      {
        ok: true,
        data,
        metadata: {
          ...makeMetadata("outcome-diagnose", context.correlationId, config),
          fallback: false,
          routeReason: ROUTE_REASONS.predictive,
          error: null,
          latencyMs: Date.now() - startedAt,
        },
      },
      200,
    );
  } catch (error) {
    const appError = normalizeError(error);
    return json(
      {
        ok: false,
        error: {
          code: appError.code,
          message: safeMessage(appError.code),
          retryable: appError.retryable,
        },
      },
      appError.status,
    );
  }
}

async function handleHoldoutReportRoute(
  request: Request,
  env: GrowthAgentEnv,
  config: RuntimeConfig,
): Promise<Response> {
  try {
    requireInternalAuth(request, env, config);
    const url = new URL(request.url);
    const windowDays = parsePositiveInt(url.searchParams.get("windowDays"), 30, 365);
    const minArmSample = parsePositiveInt(url.searchParams.get("minArmSample"), 50, 10_000);
    const report = await buildHoldoutReport(env, {
      windowDays,
      minArmSample,
      experimentId: url.searchParams.get("experimentId"),
      actionType: url.searchParams.get("actionType"),
    });

    return json({ ok: true, data: report }, 200);
  } catch (error) {
    const appError = normalizeError(error);
    return json(
      {
        ok: false,
        error: {
          code: appError.code,
          message: safeMessage(appError.code),
          retryable: appError.retryable,
        },
      },
      appError.status,
    );
  }
}

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function createLlmAdapter(env: GrowthAgentEnv): LlmAdapter {
  const primary = new WorkersAiAdapter(env);
  if (env.SECONDARY_LLM_PROVIDER_URL && env.SECONDARY_LLM_PROVIDER_API_KEY) {
    const secondary = new FetchLlmAdapter(env.SECONDARY_LLM_PROVIDER_URL, env.SECONDARY_LLM_PROVIDER_API_KEY);
    return new FailoverLlmAdapter(primary, secondary);
  }
  return primary;
}

function safeMessage(code: string): string {
  const safe: Record<string, string> = {
    UNAUTHORIZED: "Unauthorized.",
    VALIDATION_ERROR: "Invalid request.",
    UPSTREAM_TIMEOUT: "The request timed out.",
    UPSTREAM_FAILURE: "Upstream service error.",
    UPSTREAM_QUOTA_EXCEEDED: "Upstream quota exceeded.",
    BUDGET_EXHAUSTED: "Budget limit reached.",
    OUTPUT_SCHEMA_INVALID: "Response could not be validated.",
    CAPABILITY_DISABLED: "This capability is currently unavailable.",
    RATE_LIMITED: "Too many requests.",
    CORRELATION_NOT_FOUND: "Correlation was not found.",
    DUPLICATE_OUTCOME: "Duplicate outcome rejected.",
    INTERNAL_FALLBACK: "Fallback response served.",
    INTERNAL_ERROR: "An internal error occurred.",
  };
  return safe[code] ?? "The request could not be processed.";
}

async function safeReadBody(request: Request): Promise<unknown> {
  try {
    return await request.clone().json();
  } catch {
    return {};
  }
}
