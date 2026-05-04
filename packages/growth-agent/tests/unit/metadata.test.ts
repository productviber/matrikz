import { describe, expect, it } from "vitest";
import { MetadataSchema } from "@matrikz/growth-agent-contracts";
import { makeMetadata } from "../../src/errors";
import { DEFAULTS, ROUTE_REASONS } from "../../src/constants";
import type { RuntimeConfig } from "../../src/types";

const baseConfig: RuntimeConfig = {
  appVersion: "0.1.0",
  requestSchemaVersion: "1.0.0",
  responseSchemaVersion: "1.0.0",
  model: "@cf/meta/llama-3.1-8b-instruct",
  timeoutMs: 3500,
  maxRetries: 1,
  outputRepairAttempts: 1,
  budgetPerTenantPerMinute: 120,
  rateLimitPerTenantCapabilityPerMinute: 180,
  secretRotationWindowHours: 24,
  featureFlags: {
    "growth-next-action": true,
    "growth-signal-summarize": true,
    "journey-critic": true,
    "message-brief": true,
    "outcome-diagnose": true,
  },
};

describe("makeMetadata", () => {
  it("produces a metadata object that satisfies MetadataSchema for each capability", () => {
    const capabilities = [
      "growth-next-action",
      "growth-signal-summarize",
      "journey-critic",
      "message-brief",
      "outcome-diagnose",
    ] as const;

    for (const capability of capabilities) {
      const meta = makeMetadata(capability, "tenant-1:123e4567-e89b-42d3-a456-426614174000", baseConfig);
      const result = MetadataSchema.safeParse(meta);
      expect(result.success, `Schema failed for ${capability}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it("defaults to predictive routeReason and no error", () => {
    const meta = makeMetadata(
      "growth-next-action",
      "tenant-1:123e4567-e89b-42d3-a456-426614174000",
      baseConfig,
    );
    expect(meta.routeReason).toBe(ROUTE_REASONS.predictive);
    expect(meta.error).toBeNull();
    expect(meta.fallback).toBe(false);
  });

  it("accepts overrides that are reflected in output", () => {
    const meta = makeMetadata(
      "journey-critic",
      "tenant-1:123e4567-e89b-42d3-a456-426614174001",
      baseConfig,
      {
        latencyMs: 250,
        fallback: true,
        routeReason: ROUTE_REASONS.fallback,
        error: "UPSTREAM_TIMEOUT",
      },
    );
    expect(meta.latencyMs).toBe(250);
    expect(meta.fallback).toBe(true);
    expect(meta.routeReason).toBe(ROUTE_REASONS.fallback);
    expect(meta.error).toBe("UPSTREAM_TIMEOUT");
  });

  it("promptVersion follows the capability-semver pattern from DEFAULTS", () => {
    const meta = makeMetadata(
      "outcome-diagnose",
      "tenant-1:123e4567-e89b-42d3-a456-426614174002",
      baseConfig,
    );
    expect(meta.promptVersion).toMatch(/^outcome-diagnose-\d+\.\d+\.\d+$/);
    expect(meta.promptVersion).toContain(DEFAULTS.responseSchemaVersion);
  });
});
