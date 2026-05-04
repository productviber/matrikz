import { describe, expect, it, beforeEach } from "vitest";
import { callGrowthAgent, resetCircuitState } from "../src/client";
import growthAgentWorker from "../../growth-agent/src/index";
import type { GrowthCapability, MarketingEnv } from "../src/types";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeLiveEnv(aiResponse: unknown, extraFlags: Record<string, boolean> = {}): MarketingEnv {
  const featureFlags = {
    "growth-next-action": true,
    "growth-signal-summarize": true,
    "journey-critic": true,
    "message-brief": true,
    "outcome-diagnose": true,
    ...extraFlags,
  };

  return {
    INTERNAL_SECRET: "secret",
    GROWTH_AGENT: {
      async fetch(input, init) {
        const req = new Request(input, init);
        return growthAgentWorker.fetch(req, {
          INTERNAL_SECRET: "secret",
          AI_TIMEOUT_MS: "50",
          AI_MAX_RETRIES: "0",
          AI_OUTPUT_REPAIR_ATTEMPTS: "0",
          FEATURE_FLAGS_JSON: JSON.stringify(featureFlags),
          AI_MODEL: "model",
          WORKERS_AI: {
            async run() {
              return { response: JSON.stringify(aiResponse) };
            },
          },
        });
      },
    },
  };
}

const CORR = "tenant-1:123e4567-e89b-42d3-a456-426614174000";

// ─── tests ──────────────────────────────────────────────────────────────────

describe("marketer -> growth-agent e2e normalization", () => {
  beforeEach(() => {
    resetCircuitState();
  });

  it("normalizes successful growth-next-action response", async () => {
    const env = makeLiveEnv({
      action: { type: "send_message", params: {}, reason: "intent" },
      riskLevel: "low",
      confidence: 0.72,
      explanation: "Proceed",
      rawSummary: "summary",
    });

    const result = await callGrowthAgent({
      env,
      capability: "growth-next-action",
      tenantId: "tenant-1",
      correlationId: CORR,
      payload: {
        subjectId: "subject-1",
        signals: [{ kind: "number", name: "intent", value: 8 }],
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata.capability).toBe("growth-next-action");
      expect(result.metadata.responseSchemaVersion).toBe("1.0.0");
    }
  });

  // ─── correlation-id continuity ──────────────────────────────────────────
  it("preserves correlation-id from marketing request through to response metadata", async () => {
    const env = makeLiveEnv({
      action: { type: "wait", params: { cooldownHours: 1, subjectId: "s" }, reason: "low signal" },
      riskLevel: "low",
      confidence: 0.5,
      explanation: "Wait",
      rawSummary: "low",
    });

    const result = await callGrowthAgent({
      env,
      capability: "growth-next-action",
      tenantId: "tenant-1",
      correlationId: CORR,
      payload: {
        subjectId: "subject-corr",
        signals: [{ kind: "number", name: "intent", value: 5 }],
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The growth-agent must echo back the exact correlationId it received.
      expect(result.metadata.correlationId).toBe(CORR);
    }
  });

  // ─── multi-capability smoke ─────────────────────────────────────────────
  it("normalizes growth-signal-summarize response", async () => {
    const env = makeLiveEnv({
      summary: "intent spike observed",
      severity: "medium",
      keyDrivers: ["intent", "engagement"],
      urgencyWindow: "next_48_hours",
    });

    const result = await callGrowthAgent({
      env,
      capability: "growth-signal-summarize",
      tenantId: "tenant-1",
      correlationId: CORR,
      payload: {
        signals: [
          { kind: "number", name: "intent", value: 0.9 },
          { kind: "boolean", name: "engagement", value: true },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata.capability).toBe("growth-signal-summarize");
    }
  });

  it("normalizes journey-critic response", async () => {
    const env = makeLiveEnv({
      critique: "journey is stale at onboarding stage",
      risks: ["dropoff", "disengagement"],
      suggestedAdjustments: ["accelerate_trial", "personalize_email"],
    });

    const result = await callGrowthAgent({
      env,
      capability: "journey-critic",
      tenantId: "tenant-1",
      correlationId: CORR,
      payload: {
        journeyState: { stage: "onboarding", health: 60 },
        priorActions: [],
        outcomes: [],
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata.capability).toBe("journey-critic");
    }
  });

  it("normalizes message-brief response", async () => {
    const env = makeLiveEnv({
      headline: "Get back on track",
      coreMessage: "Your account is ready for the next step",
      tone: "friendly",
      cta: "Continue now",
      guardrails: ["no_pricing", "white_label_safe"],
    });

    const result = await callGrowthAgent({
      env,
      capability: "message-brief",
      tenantId: "tenant-1",
      correlationId: CORR,
      payload: {
        objective: "Re-engage inactive users",
        audience: "enterprise mid-market",
        channelHints: ["email"],
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata.capability).toBe("message-brief");
    }
  });

  it("normalizes outcome-diagnose response", async () => {
    const env = makeLiveEnv({
      diagnosis: "churn accelerated due to support lag",
      likelyCauses: ["slow_resolution_time", "feature_gap"],
      recommendedNextExperiments: ["cs_outreach_cohort", "feature_survey"],
    });

    const result = await callGrowthAgent({
      env,
      capability: "outcome-diagnose",
      tenantId: "tenant-1",
      correlationId: CORR,
      payload: {
        expected: { churnRate: 0.03, mrr: 50000 },
        observed: { churnRate: 0.07, mrr: 44000 },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata.capability).toBe("outcome-diagnose");
    }
  });

  // ─── fallback path from live worker ────────────────────────────────────
  it("returns circuit fallback when growth-agent is unreachable", async () => {
    const env: MarketingEnv = {
      INTERNAL_SECRET: "secret",
      GROWTH_AGENT_TIMEOUT_MS: "5",
      GROWTH_AGENT: {
        async fetch() {
          return await new Promise<Response>(() => undefined);
        },
      },
    };

    const result = await callGrowthAgent<unknown>({
      env,
      capability: "growth-next-action" as GrowthCapability,
      tenantId: "tenant-timeout",
      correlationId: "tenant-timeout:123e4567-e89b-42d3-a456-426614174000",
      payload: { subjectId: "s", signals: [] },
    });

    expect(result.ok).toBe(false);
    expect(result.metadata.fallback).toBe(true);
    expect(result.metadata.routeReason).toContain("timeout");
  });
});
