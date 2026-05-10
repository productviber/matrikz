import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { GrowthAgentEnv } from "../../src/types";
import { CAPABILITY_NAMES, MAX_PAYLOAD_BYTES } from "../../src/constants";
import {
  detailedGrowthNextActionPayload,
  detailedGrowthSignalSummarizePayload,
  detailedJourneyCriticPayload,
  detailedMessageBriefPayload,
  detailedOutcomeDiagnosePayload,
  invalidGrowthNextActionPayload,
  invalidGrowthSignalSummarizePayload,
  invalidJourneyCriticPayload,
  invalidMessageBriefPayload,
  invalidOutcomeDiagnosePayload,
} from "../fixtures/payloads";

// Typed response helpers so every test gets proper TS inference.
interface OkEnvelope {
  ok: true;
  data: unknown;
  metadata: {
    responseSchemaVersion: string;
    correlationId: string;
    fallback: boolean;
    routeReason: string;
    capability: string;
    latencyMs: number;
  };
}
interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string; retryable: boolean };
  metadata: { responseSchemaVersion: string; correlationId: string; fallback: boolean };
}
type Envelope = OkEnvelope | ErrorEnvelope;

const corr = "tenant-1:123e4567-e89b-42d3-a456-426614174000";

function makeEnv(partial?: Partial<GrowthAgentEnv>): GrowthAgentEnv {
  return {
    INTERNAL_SECRET: "secret",
    AI_TIMEOUT_MS: "20",
    AI_MAX_RETRIES: "0",
    AI_OUTPUT_REPAIR_ATTEMPTS: "1",
    CAPABILITY_GROWTH_NEXT_ACTION_ENABLED: "true",
    FEATURE_FLAGS_JSON: JSON.stringify({
      "growth-next-action": true,
      "growth-signal-summarize": true,
      "journey-critic": true,
      "message-brief": true,
      "outcome-diagnose": true,
    }),
    AI_MODEL: "model",
    WORKERS_AI: {
      async run(_model, input) {
        const rawPrompt = (input as { messages?: { content: string }[] })?.messages?.[1]?.content;
        const parsed = rawPrompt ? (JSON.parse(rawPrompt) as Record<string, unknown>) : {};
        const payload = (parsed.input ?? {}) as Record<string, unknown>;

        if (payload.subjectId) {
          return {
            response: JSON.stringify({
                action: { type: "activate", params: {}, reason: "intent" },
              riskLevel: "low",
              confidence: 0.8,
              explanation: "Go",
              rawSummary: "summary",
            }),
          };
        }

        if (payload.objective) {
          return {
            response: JSON.stringify({
              headline: "Save time",
              coreMessage: "Automate now",
              tone: "clear",
              cta: "Start today",
              guardrails: ["no_overpromise"],
            }),
          };
        }

        if (payload.journeyState) {
          return {
            response: JSON.stringify({
              critique: "state is stale",
              risks: ["dropoff"],
              suggestedAdjustments: ["shorten step"],
            }),
          };
        }

        if (payload.expected) {
          return {
            response: JSON.stringify({
              diagnosis: "timing mismatch",
              likelyCauses: ["channel delay"],
              recommendedNextExperiments: ["time-window-shift"],
            }),
          };
        }

        return {
          response: JSON.stringify({
            summary: "signal trend",
            severity: "medium",
            keyDrivers: ["intent"],
            urgencyWindow: "next_72_hours",
          }),
        };
      },
    },
    ...partial,
  };
}

function makeRequest(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
  bodyOverride?: BodyInit,
): Request {
  return new Request(`https://growth-agent${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": "secret",
      "x-correlation-id": corr,
      "x-tenant-id": "tenant-1",
      ...headers,
    },
    body: bodyOverride ?? JSON.stringify(body),
  });
}

function makeGetRequest(path: string, headers?: Record<string, string>): Request {
  return new Request(`https://growth-agent${path}`, {
    method: "GET",
    headers: {
      "x-internal-secret": "secret",
      "x-correlation-id": corr,
      "x-tenant-id": "tenant-1",
      ...headers,
    },
  });
}

function makeOutcomeDb(rows: unknown[]): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            async all() {
              return { results: rows };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("growth-agent integration", () => {
  // ───────────────────── auth ──────────────────────
  it("rejects unauthorized requests", async () => {
    const req = makeRequest(
      "/internal/growth-next-action",
      { subjectId: "s", signals: [] },
      { "x-internal-secret": "bad" },
    );
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(401);
  });

  it("accepts previous secret during rotation window", async () => {
    const req = makeRequest(
      "/internal/growth-next-action",
      { subjectId: "s", signals: [{ kind: "number", name: "intent", value: 9 }] },
      { "x-internal-secret": "old-secret" },
    );
    const res = await worker.fetch(req, makeEnv({ INTERNAL_SECRET_PREVIOUS: "old-secret" }));
    expect(res.status).toBe(200);
  });

  it("returns success envelope on valid request", async () => {
    const req = makeRequest("/internal/growth-next-action", {
      subjectId: "s",
      signals: [{ kind: "number", name: "intent", value: 9 }],
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      ok: boolean;
      metadata: { responseSchemaVersion: string; correlationId: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.metadata.responseSchemaVersion).toBe("1.0.0");
    expect(payload.metadata.correlationId).toBe(corr);
  });

  it("handles detailed growth-next-action payloads with rich signals and context", async () => {
    const req = makeRequest("/internal/growth-next-action", detailedGrowthNextActionPayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as any;
    expect(payload.ok).toBe(true);
    expect(payload.metadata.correlationId).toBe(corr);
  });

  it("rejects invalid growth-next-action payloads", async () => {
    const req = makeRequest("/internal/growth-next-action", invalidGrowthNextActionPayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const payload = await res.json() as any;
    expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  it("handles detailed growth-signal-summarize payloads", async () => {
    const req = makeRequest("/internal/growth-signal-summarize", detailedGrowthSignalSummarizePayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as any;
    expect(payload.ok).toBe(true);
  });

  it("rejects invalid growth-signal-summarize payloads", async () => {
    const req = makeRequest("/internal/growth-signal-summarize", invalidGrowthSignalSummarizePayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const payload = await res.json() as any;
    expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  it("handles detailed journey-critic payloads", async () => {
    const req = makeRequest("/internal/journey-critic", detailedJourneyCriticPayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as any;
    expect(payload.ok).toBe(true);
  });

  it("rejects invalid journey-critic payloads", async () => {
    const req = makeRequest("/internal/journey-critic", invalidJourneyCriticPayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const payload = await res.json() as any;
    expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  it("handles detailed message-brief payloads", async () => {
    const req = makeRequest("/internal/message-brief", detailedMessageBriefPayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as any;
    expect(payload.ok).toBe(true);
  });

  it("rejects invalid message-brief payloads", async () => {
    const req = makeRequest("/internal/message-brief", invalidMessageBriefPayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const payload = await res.json() as any;
    expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  it("handles detailed outcome-diagnose payloads", async () => {
    const req = makeRequest("/internal/outcome-diagnose", detailedOutcomeDiagnosePayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as any;
    expect(payload.ok).toBe(true);
  });

  it("rejects invalid outcome-diagnose payloads", async () => {
    const req = makeRequest("/internal/outcome-diagnose", invalidOutcomeDiagnosePayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const payload = await res.json() as any;
    expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns validation error for malformed correlation id", async () => {
    const req = makeRequest(
      "/internal/growth-next-action",
      { subjectId: "s", signals: [{ kind: "number", name: "intent", value: 9 }] },
      { "x-correlation-id": "bad" },
    );
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
  });

  it("rejects an invalid idempotency key format", async () => {
    // Idempotency key present but not a UUID v4 must be rejected.
    const req = makeRequest(
      "/internal/growth-next-action",
      { subjectId: "s", signals: [{ kind: "number", name: "intent", value: 9 }] },
      { "x-idempotency-key": "not-a-uuid" },
    );
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const payload = await json(res);
    expect(payload.ok).toBe(false);
    if (!payload.ok) {
      expect(payload.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("accepts a valid UUID v4 idempotency key", async () => {
    const req = makeRequest(
      "/internal/growth-next-action",
      { subjectId: "s", signals: [{ kind: "number", name: "intent", value: 9 }] },
      { "x-idempotency-key": "550e8400-e29b-41d4-a716-446655440000" },
    );
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
  });

  // ──────────────────── payload size ───────────────────
  it("rejects payloads that exceed MAX_PAYLOAD_BYTES", async () => {
    // Build a body that is definitely > 32 KB.
    const oversized = JSON.stringify({
      subjectId: "s",
      signals: [],
      context: { padding: "x".repeat(MAX_PAYLOAD_BYTES + 1024) },
    });
    const req = makeRequest(
      "/internal/growth-next-action",
      null,
      {},
      oversized,
    );
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const payload = await json(res);
    if (!payload.ok) {
      expect(payload.error.code).toBe("VALIDATION_ERROR");
    }
  });

  // ──────────────────── /health ────────────────────────
  it("responds to GET /health without auth", async () => {
    const req = new Request("https://growth-agent/health", { method: "GET" });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok: boolean; data: { status: string } };
    expect(payload.ok).toBe(true);
    expect(payload.data.status).toBe("ok");
  });

  // ──────────────────── /internal/capabilities ─────────
  it("GET /internal/capabilities returns all enabled capabilities", async () => {
    const req = makeGetRequest("/internal/capabilities");
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      ok: boolean;
      data: {
        capabilities: { name: string; enabled: boolean; path: string }[];
      };
    };
    expect(payload.ok).toBe(true);
    const names = payload.data.capabilities.map((c) => c.name);
    for (const cap of Object.values(CAPABILITY_NAMES)) {
      expect(names).toContain(cap);
    }
    for (const cap of payload.data.capabilities) {
      expect(cap.enabled).toBe(true);
      expect(cap.path).toMatch(/^\/internal\//);
    }
  });

  it("GET /internal/capabilities returns 401 without auth", async () => {
    const req = new Request("https://growth-agent/internal/capabilities", { method: "GET" });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(401);
  });

  // ──────────────────── success envelope ───────────────
  it("returns success envelope with correlation id and schema version", async () => {
    const req = makeRequest("/internal/growth-next-action", {
      subjectId: "s",
      signals: [{ kind: "number", name: "intent", value: 9 }],
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const payload = await json(res);
    expect(payload.ok).toBe(true);
    if (payload.ok) {
      expect(payload.metadata.responseSchemaVersion).toBe("1.0.0");
      expect(payload.metadata.correlationId).toBe(corr);
      expect(payload.metadata.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  // ──────────────────── all capabilities ───────────────
  it("handles growth-next-action with rich payload", async () => {
    const req = makeRequest("/internal/growth-next-action", detailedGrowthNextActionPayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const payload = await json(res);
    expect(payload.ok).toBe(true);
    if (payload.ok) {
      expect(payload.data).toBeDefined();
      expect(payload.metadata.correlationId).toBe(corr);
    }
  });

  it("rejects invalid growth-next-action payload", async () => {
    const req = makeRequest("/internal/growth-next-action", invalidGrowthNextActionPayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const payload = await json(res);
    expect(payload.ok).toBe(false);
    if (!payload.ok) expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  it("handles growth-signal-summarize with rich payload", async () => {
    const req = makeRequest("/internal/growth-signal-summarize", detailedGrowthSignalSummarizePayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const payload = await json(res);
    expect(payload.ok).toBe(true);
  });

  it("rejects invalid growth-signal-summarize payload", async () => {
    const req = makeRequest("/internal/growth-signal-summarize", invalidGrowthSignalSummarizePayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const payload = await json(res);
    if (!payload.ok) expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  it("handles journey-critic with rich payload", async () => {
    const req = makeRequest("/internal/journey-critic", detailedJourneyCriticPayload);
    const res = await worker.fetch(
      req,
      makeEnvWithResponse({ critique: "state is stale", risks: ["dropoff"], suggestedAdjustments: ["shorten step"] }),
    );
    expect(res.status).toBe(200);
    const payload = await json(res);
    expect(payload.ok).toBe(true);
  });

  it("rejects invalid journey-critic payload", async () => {
    const req = makeRequest("/internal/journey-critic", invalidJourneyCriticPayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const payload = await json(res);
    if (!payload.ok) expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  it("handles message-brief with rich payload", async () => {
    const req = makeRequest("/internal/message-brief", detailedMessageBriefPayload);
    const res = await worker.fetch(
      req,
      makeEnvWithResponse({ headline: "Save time", coreMessage: "Automate now", tone: "clear", cta: "Start today", guardrails: ["no_overpromise"] }),
    );
    expect(res.status).toBe(200);
    const payload = await json(res);
    expect(payload.ok).toBe(true);
  });

  it("rejects invalid message-brief payload", async () => {
    const req = makeRequest("/internal/message-brief", invalidMessageBriefPayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const payload = await json(res);
    if (!payload.ok) expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  it("handles outcome-diagnose with rich payload", async () => {
    const req = makeRequest("/internal/outcome-diagnose", detailedOutcomeDiagnosePayload);
    const res = await worker.fetch(
      req,
      makeEnvWithResponse({ diagnosis: "timing mismatch", likelyCauses: ["channel delay"], recommendedNextExperiments: ["time-window-shift"] }),
    );
    expect(res.status).toBe(200);
    const payload = await json(res);
    expect(payload.ok).toBe(true);
  });

  it("rejects invalid outcome-diagnose payload", async () => {
    const req = makeRequest("/internal/outcome-diagnose", invalidOutcomeDiagnosePayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const payload = await json(res);
    if (!payload.ok) expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  // ──────────────────── failure classes ────────────────
  it("returns timeout error when provider stalls", async () => {
    const req = makeRequest("/internal/growth-next-action", {
      subjectId: "s",
      signals: [{ kind: "number", name: "intent", value: 1 }],
    });
    const res = await worker.fetch(
      req,
      makeEnv({
        AI_TIMEOUT_MS: "5",
        WORKERS_AI: {
          async run(_model, _input, options) {
            return await new Promise<never>((_, reject) => {
              options?.signal?.addEventListener("abort", () => {
                const abortError = new Error("Aborted");
                abortError.name = "AbortError";
                reject(abortError);
              });
            });
          },
        },
      }),
    );
    expect(res.status).toBe(504);
    const payload = await json(res);
    if (!payload.ok) expect(payload.error.code).toBe("UPSTREAM_TIMEOUT");
  });

  it("returns 503 when capability disabled, with retry-after header", async () => {
    const req = makeRequest("/internal/growth-next-action", { subjectId: "s", signals: [] });
    const res = await worker.fetch(req, makeEnv({ CAPABILITY_GROWTH_NEXT_ACTION_ENABLED: "false" }));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("300");
    const payload = await json(res);
    if (!payload.ok) expect(payload.error.code).toBe("CAPABILITY_DISABLED");
  });

  it("returns 429 when tenant is rate limited", async () => {
    const env = makeEnv({ RATE_LIMIT_PER_TENANT_CAPABILITY_PER_MIN: "1" });
    const body = { subjectId: "s", signals: [{ kind: "number", name: "intent", value: 9 }] };
    await worker.fetch(makeRequest("/internal/growth-next-action", body), env);
    const second = await worker.fetch(makeRequest("/internal/growth-next-action", body), env);
    expect(second.status).toBe(429);
    const payload = await json(second);
    if (!payload.ok) expect(payload.error.retryable).toBe(true);
  });

  it("returns degraded success envelope when budget is exhausted", async () => {
    const env = makeEnv({ BUDGET_PER_TENANT_PER_MIN: "1" });
    const body = { subjectId: "s", signals: [{ kind: "number", name: "intent", value: 9 }] };
    await worker.fetch(makeRequest("/internal/growth-next-action", body), env);
    const second = await worker.fetch(makeRequest("/internal/growth-next-action", body), env);
    expect(second.status).toBe(200);
    const payload = await json(second);
    expect(payload.ok).toBe(true);
    if (payload.ok) {
      expect(payload.metadata.fallback).toBe(true);
    }
  });

  it("returns experiment holdout report for internal operators", async () => {
    const req = makeGetRequest("/internal/experiments/holdout-report?windowDays=30&minArmSample=20");
    const res = await worker.fetch(
      req,
      makeEnv({
        OUTCOME_DB: makeOutcomeDb([
          {
            experimentId: "exp-agentic-1",
            arm: "control",
            capability: "growth-next-action",
            actionType: "activate",
            recommendations: 30,
            outcomes: 8,
            positiveOutcomes: 4,
            conversions: 1,
            totalDelta: 2,
            avgObservedDelta: 0.25,
          },
          {
            experimentId: "exp-agentic-1",
            arm: "treatment",
            capability: "growth-next-action",
            actionType: "activate",
            recommendations: 40,
            outcomes: 16,
            positiveOutcomes: 12,
            conversions: 4,
            totalDelta: 7,
            avgObservedDelta: 0.43,
          },
        ]),
      }),
    );

    expect(res.status).toBe(200);
    const payload = await res.json() as any;
    expect(payload.ok).toBe(true);
    expect(payload.data.comparisons[0].experimentId).toBe("exp-agentic-1");
    expect(payload.data.comparisons[0].uplift.positiveOutcomeRate).toBeGreaterThan(0);
  });
});
