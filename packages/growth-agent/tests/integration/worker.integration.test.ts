import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { GrowthAgentEnv } from "../../src/types";
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

// base36 correlation format: ${base36timestamp}-${4+chars}
const corr = "lq3abc-xy12";

function makeEnv(partial?: Partial<GrowthAgentEnv>): GrowthAgentEnv {
  return {
    INTERNAL_SECRET: "secret",
    AI_TIMEOUT_MS: "20",
    AI_MAX_RETRIES: "0",
    AI_OUTPUT_REPAIR_ATTEMPTS: "1",
    CAPABILITY_GROWTH_NEXT_ACTION_ENABLED: "true",
    CAPABILITY_GROWTH_SIGNAL_SUMMARIZE_ENABLED: "true",
    CAPABILITY_JOURNEY_CRITIC_ENABLED: "true",
    CAPABILITY_MESSAGE_BRIEF_ENABLED: "true",
    CAPABILITY_OUTCOME_DIAGNOSE_ENABLED: "true",
    AI_MODEL: "model",
    WORKERS_AI: {
      async run(_model, input) {
        const rawPrompt = (input as any)?.messages?.[1]?.content;
        const parsed = rawPrompt ? JSON.parse(rawPrompt) : {};
        const payload = parsed.input ?? {};

        if (payload.subjectId) {
          return {
            response: JSON.stringify({
              action: { type: "send_via_skrip", params: {}, reason: "intent" },
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

function makeRequest(path: string, body: unknown, headers?: Record<string, string>): Request {
  return new Request(`https://growth-agent${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": "secret",
      "x-correlation-id": corr,
      "x-tenant-id": "tenant-1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("growth-agent integration", () => {
  it("rejects unauthorized requests", async () => {
    const req = makeRequest(
      "/internal/growth-next-action",
      { subjectId: "s", signals: [] },
      { "x-internal-secret": "bad" },
    );
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(401);
  });

  it("accepts rollover secret during rotation window", async () => {
    const req = makeRequest(
      "/internal/growth-next-action",
      { subjectId: "s", signals: [{ kind: "number", name: "intent", value: 9 }] },
      { "x-internal-secret": "old-secret" },
    );
    const res = await worker.fetch(req, makeEnv({ INTERNAL_SECRET_ROLLOVER: "old-secret" }));
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
    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(payload.metadata.correlationId).toBe(corr);
  });

  it("rejects invalid growth-next-action payloads", async () => {
    const req = makeRequest("/internal/growth-next-action", invalidGrowthNextActionPayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  it("handles detailed growth-signal-summarize payloads", async () => {
    const req = makeRequest("/internal/growth-signal-summarize", detailedGrowthSignalSummarizePayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.ok).toBe(true);
  });

  it("rejects invalid growth-signal-summarize payloads", async () => {
    const req = makeRequest("/internal/growth-signal-summarize", invalidGrowthSignalSummarizePayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  it("handles detailed journey-critic payloads", async () => {
    const req = makeRequest("/internal/journey-critic", detailedJourneyCriticPayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.ok).toBe(true);
  });

  it("rejects invalid journey-critic payloads", async () => {
    const req = makeRequest("/internal/journey-critic", invalidJourneyCriticPayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  it("handles detailed message-brief payloads", async () => {
    const req = makeRequest("/internal/message-brief", detailedMessageBriefPayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.ok).toBe(true);
  });

  it("rejects invalid message-brief payloads", async () => {
    const req = makeRequest("/internal/message-brief", invalidMessageBriefPayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  it("handles detailed outcome-diagnose payloads", async () => {
    const req = makeRequest("/internal/outcome-diagnose", detailedOutcomeDiagnosePayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.ok).toBe(true);
  });

  it("rejects invalid outcome-diagnose payloads", async () => {
    const req = makeRequest("/internal/outcome-diagnose", invalidOutcomeDiagnosePayload);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const payload = await res.json();
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
            return await new Promise((_resolve, reject) => {
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
  });

  it("returns 503 when capability disabled", async () => {
    const req = makeRequest("/internal/growth-next-action", { subjectId: "s", signals: [] });
    const res = await worker.fetch(
      req,
      makeEnv({ CAPABILITY_GROWTH_NEXT_ACTION_ENABLED: "false" }),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("300");
  });

  it("returns 429 when tenant rate limited", async () => {
    const env = makeEnv({ RATE_LIMIT_PER_TENANT_CAPABILITY_PER_MIN: "1" });
    const body = { subjectId: "s", signals: [{ kind: "number", name: "intent", value: 9 }] };
    await worker.fetch(makeRequest("/internal/growth-next-action", body), env);
    const second = await worker.fetch(makeRequest("/internal/growth-next-action", body), env);
    expect(second.status).toBe(429);
  });
});
