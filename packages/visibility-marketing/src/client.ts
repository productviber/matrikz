import type {
  GrowthAgentEnvelope,
  GrowthCapability,
  MarketingEnv,
} from "./types";

const DEFAULT_TIMEOUT_MS = 1800;

const circuitState = {
  failures: 0,
  openedAt: 0,
};

const MAX_FAILURES = 3;
const OPEN_WINDOW_MS = 15_000;

/**
 * Reset circuit state. Exported for use in test environments only.
 * Do not call in production code paths.
 */
export function resetCircuitState(): void {
  circuitState.failures = 0;
  circuitState.openedAt = 0;
}

export async function callGrowthAgent<T>(args: {
  env: MarketingEnv;
  capability: GrowthCapability;
  tenantId: string;
  correlationId: string;
  payload: unknown;
}): Promise<GrowthAgentEnvelope<T>> {
  if (isCircuitOpen()) {
    return deterministicFallback<T>(args.capability, "circuit_open");
  }

  if (!args.env.GROWTH_AGENT || !args.env.INTERNAL_SECRET) {
    return deterministicFallback<T>(args.capability, "binding_unavailable");
  }

  const timeoutMs = parseTimeout(args.env.GROWTH_AGENT_TIMEOUT_MS);
  const timeoutError = new Error("timeout");

  try {
    const response = (await Promise.race([
      args.env.GROWTH_AGENT.fetch(`https://growth-agent/internal/${args.capability}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": args.env.INTERNAL_SECRET,
          "x-correlation-id": args.correlationId,
          "x-tenant-id": args.tenantId,
          "x-idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify(args.payload),
      }),
      new Promise<Response>((_, reject) => {
        setTimeout(() => reject(timeoutError), timeoutMs);
      }),
    ])) as Response;

    const payload = (await response.json()) as GrowthAgentEnvelope<T>;

    if (response.status === 503 && !payload.ok && payload.error.code === "CAPABILITY_DISABLED") {
      return deterministicFallback<T>(args.capability, "capability_disabled");
    }

    if (!response.ok || !payload.ok) {
      registerFailure();
      return deterministicFallback<T>(args.capability, "upstream_non_2xx");
    }

    resetCircuit();
    return normalizeEnvelope(payload, args.capability);
  } catch {
    registerFailure();
    return deterministicFallback<T>(args.capability, "timeout_or_transport");
  }
}

function normalizeEnvelope<T>(
  payload: GrowthAgentEnvelope<T>,
  capability: GrowthCapability,
): GrowthAgentEnvelope<T> {
  const metadata = payload.metadata ?? {
    provider: "workers-ai",
    model: "unknown",
    capability,
    promptVersion: "v1",
    requestSchemaVersion: "1.0.0",
    responseSchemaVersion: "1.0.0",
    correlationId: "unknown",
    latencyMs: 0,
    tokenEstimate: 0,
    costEstimate: 0,
    fallback: false,
    routeReason: "predictive",
    error: null,
  };

  return {
    ...payload,
    metadata: {
      ...metadata,
      capability,
    },
  };
}

function deterministicFallback<T>(
  capability: GrowthCapability,
  reason: string,
): GrowthAgentEnvelope<T> {
  return {
    ok: false,
    error: {
      code: "INTERNAL_FALLBACK",
      message: "Using deterministic fallback",
      retryable: true,
    },
    metadata: {
      provider: "deterministic",
      model: "fallback",
      capability,
      promptVersion: "v1",
      requestSchemaVersion: "1.0.0",
      responseSchemaVersion: "1.0.0",
      correlationId: "unknown",
      latencyMs: 0,
      tokenEstimate: 0,
      costEstimate: 0,
      fallback: true,
      routeReason: reason,
      error: "INTERNAL_FALLBACK",
    },
  };
}

function parseTimeout(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function isCircuitOpen(): boolean {
  if (circuitState.failures < MAX_FAILURES) {
    return false;
  }
  if (Date.now() - circuitState.openedAt > OPEN_WINDOW_MS) {
    resetCircuit();
    return false;
  }
  return true;
}

function registerFailure(): void {
  circuitState.failures += 1;
  if (circuitState.failures >= MAX_FAILURES && circuitState.openedAt === 0) {
    circuitState.openedAt = Date.now();
  }
}

function resetCircuit(): void {
  circuitState.failures = 0;
  circuitState.openedAt = 0;
}
