import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { GrowthAgentEnv } from "../../src/types";

// base36 correlation format: ${base36timestamp}-${4+chars}
const corr = "lq3abc-xy12";

function makeEnv(partial?: Partial<GrowthAgentEnv>): GrowthAgentEnv {
  return {
    INTERNAL_SECRET: "secret",
    AI_TIMEOUT_MS: "20",
    AI_MAX_RETRIES: "0",
    AI_OUTPUT_REPAIR_ATTEMPTS: "1",
    CAPABILITY_GROWTH_NEXT_ACTION_ENABLED: "true",
    AI_MODEL: "model",
    WORKERS_AI: {
      async run() {
        return {
          response: JSON.stringify({
            action: { type: "send_via_skrip", params: {}, reason: "intent" },
            riskLevel: "low",
            confidence: 0.8,
            explanation: "Go",
            rawSummary: "summary",
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
