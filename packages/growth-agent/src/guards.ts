import { ROUTE_REASONS } from "./constants";
import type {
  CapabilityName,
  TenantBudgetGuard,
  TenantRateLimitGuard,
} from "./types";

const budgetStore = new Map<string, number>();
const rateStore = new Map<string, number>();

export class InMemoryBudgetGuard implements TenantBudgetGuard {
  constructor(private readonly limitPerMinute: number) {}

  consume(tenantId: string, capability: CapabilityName): { allowed: boolean; remaining: number } {
    const key = `${tenantId}:${capability}:${Math.floor(Date.now() / 60000)}`;
    const current = budgetStore.get(key) ?? 0;
    if (current >= this.limitPerMinute) {
      return { allowed: false, remaining: 0 };
    }
    budgetStore.set(key, current + 1);
    return { allowed: true, remaining: this.limitPerMinute - current - 1 };
  }
}

export class InMemoryRateLimitGuard implements TenantRateLimitGuard {
  constructor(private readonly limitPerMinute: number) {}

  consume(tenantId: string, capability: CapabilityName): { allowed: boolean; remaining: number } {
    const key = `${tenantId}:${capability}:${Math.floor(Date.now() / 60000)}`;
    const current = rateStore.get(key) ?? 0;
    if (current >= this.limitPerMinute) {
      console.log(
        JSON.stringify({ type: "rate_limit_hit", tenantId, capability, routeReason: ROUTE_REASONS.rateLimited }),
      );
      return { allowed: false, remaining: 0 };
    }
    rateStore.set(key, current + 1);
    return { allowed: true, remaining: this.limitPerMinute - current - 1 };
  }
}

// v1 fail-open: if budget infrastructure is unavailable, favor inference continuity.
export class FailOpenBudgetGuard implements TenantBudgetGuard {
  constructor(private readonly inner: TenantBudgetGuard) {}

  consume(tenantId: string, capability: CapabilityName): { allowed: boolean; remaining: number } {
    try {
      return this.inner.consume(tenantId, capability);
    } catch {
      console.log(
        JSON.stringify({
          type: "budget_guard_unavailable",
          tenantId,
          capability,
          routeReason: ROUTE_REASONS.fallback,
        }),
      );
      return { allowed: true, remaining: Number.MAX_SAFE_INTEGER };
    }
  }
}

export class NullBudgetGuard implements TenantBudgetGuard {
  consume(_tenantId: string, _capability: CapabilityName): { allowed: boolean; remaining: number } {
    return { allowed: true, remaining: Number.MAX_SAFE_INTEGER };
  }
}

export class ExhaustedBudgetGuard implements TenantBudgetGuard {
  consume(_tenantId: string, _capability: CapabilityName): { allowed: boolean; remaining: number } {
    return { allowed: false, remaining: 0 };
  }
}
