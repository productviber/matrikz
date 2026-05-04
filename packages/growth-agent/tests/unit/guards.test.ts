import { describe, expect, it } from "vitest";
import {
  ExhaustedBudgetGuard,
  FailOpenBudgetGuard,
  InMemoryBudgetGuard,
  InMemoryRateLimitGuard,
  NullBudgetGuard,
} from "../../src/guards";

// ─────────────────────────────────────────────
//  InMemoryBudgetGuard
// ─────────────────────────────────────────────
describe("InMemoryBudgetGuard", () => {
  it("allows consumption within limit", () => {
    const guard = new InMemoryBudgetGuard(5);
    const result = guard.consume("tenant-a", "growth-next-action");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("exhausts at the limit boundary", () => {
    const guard = new InMemoryBudgetGuard(2);
    guard.consume("tenant-b", "growth-next-action");
    guard.consume("tenant-b", "growth-next-action");
    const result = guard.consume("tenant-b", "growth-next-action");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("isolates by tenantId", () => {
    const guard = new InMemoryBudgetGuard(1);
    guard.consume("tenant-c", "growth-next-action");
    const result = guard.consume("tenant-d", "growth-next-action");
    expect(result.allowed).toBe(true);
  });

  it("isolates by capability", () => {
    const guard = new InMemoryBudgetGuard(1);
    guard.consume("tenant-e", "growth-next-action");
    const result = guard.consume("tenant-e", "journey-critic");
    expect(result.allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────
//  InMemoryRateLimitGuard
// ─────────────────────────────────────────────
describe("InMemoryRateLimitGuard", () => {
  it("allows requests within limit", () => {
    const guard = new InMemoryRateLimitGuard(10);
    const result = guard.consume("tenant-f", "growth-next-action");
    expect(result.allowed).toBe(true);
  });

  it("blocks after limit is reached", () => {
    const guard = new InMemoryRateLimitGuard(1);
    guard.consume("tenant-g", "growth-next-action");
    const result = guard.consume("tenant-g", "growth-next-action");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("does not cross-contaminate tenants", () => {
    const guard = new InMemoryRateLimitGuard(1);
    guard.consume("tenant-h", "journey-critic");
    const result = guard.consume("tenant-i", "journey-critic");
    expect(result.allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────
//  FailOpenBudgetGuard
// ─────────────────────────────────────────────
describe("FailOpenBudgetGuard", () => {
  it("returns inner result when inner succeeds", () => {
    const inner = new InMemoryBudgetGuard(5);
    const guard = new FailOpenBudgetGuard(inner);
    const result = guard.consume("tenant-j", "growth-next-action");
    expect(result.allowed).toBe(true);
  });

  it("fails open when inner throws", () => {
    const broken = {
      consume(): never {
        throw new Error("storage failure");
      },
    };
    const guard = new FailOpenBudgetGuard(broken);
    const result = guard.consume("tenant-k", "growth-next-action");
    // Must allow — fail-open protects inference continuity
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Number.MAX_SAFE_INTEGER);
  });
});

// ─────────────────────────────────────────────
//  NullBudgetGuard / ExhaustedBudgetGuard
// ─────────────────────────────────────────────
describe("NullBudgetGuard", () => {
  it("always allows with max remaining", () => {
    const guard = new NullBudgetGuard();
    const result = guard.consume("any", "growth-next-action");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("ExhaustedBudgetGuard", () => {
  it("always blocks with zero remaining", () => {
    const guard = new ExhaustedBudgetGuard();
    const result = guard.consume("any", "growth-next-action");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});
