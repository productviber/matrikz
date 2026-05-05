import { PendingRecommendationSchema, type PendingRecommendation } from "@clodo/growth-agent-contracts";

// Tier-2 channel resolution: intent → concrete channel action sent to visibility-marketing.
// null means no outbound channel is triggered (fatigue guard or hold).
const CHANNEL_POLICY: Record<string, string | null> = {
  nurture:  "enroll_sequence",
  activate: "send_via_skrip",
  convert:  "start_campaign",
  recover:  "send_via_skrip",
  pause:    null,
  escalate: "escalate_to_human",
  wait:     null,
};

interface DispatcherEnv {
  ENVIRONMENT?: string;
  VISIBILITY_MARKETING_URL?: string;
  INTERNAL_SECRET?: string;
  OUTCOME_DB?: D1Database;
  DISPATCH_DLQ?: Queue<PendingRecommendation>;
  GROWTH_AGENT?: Fetcher;
  TENANT_REGISTRY_KV?: KVNamespace;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, data: { status: "ok" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: false, error: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  },

  async queue(batch: MessageBatch<unknown>, env: DispatcherEnv): Promise<void> {
    for (const message of batch.messages) {
      try {
        const parsed = PendingRecommendationSchema.safeParse(message.body);
        if (!parsed.success) {
          message.ack();
          continue;
        }

          if (parsed.data.arm === "control") {
            await markDispatched(env, parsed.data.correlationId);
            void decrementQueueDepth(env, parsed.data.tenantId);
            console.log(
              JSON.stringify({
                type: "dispatch_control_arm",
                correlationId: parsed.data.correlationId,
                experimentId: parsed.data.experimentId,
              }),
            );
            message.ack();
            continue;
          }

        await dispatchRecommendation(parsed.data, env);
        await markDispatched(env, parsed.data.correlationId);
        void decrementQueueDepth(env, parsed.data.tenantId);
        console.log(
          JSON.stringify({
            type: "dispatch_succeeded",
            tenantId: parsed.data.tenantId,
            subjectId: parsed.data.subjectId,
            correlationId: parsed.data.correlationId,
          }),
        );
        message.ack();
      } catch (error) {
        const recommendation = message.body as PendingRecommendation;
        console.log(
          JSON.stringify({
            type: "dispatch_failed",
            correlationId: recommendation?.correlationId ?? "unknown",
            error: error instanceof Error ? error.message : "unknown",
          }),
        );

        if (message.attempts >= 3 && env.DISPATCH_DLQ) {
          await env.DISPATCH_DLQ.send(recommendation);
          console.log(
            JSON.stringify({
              type: "dispatch_dead_lettered",
              correlationId: recommendation?.correlationId ?? "unknown",
            }),
          );
          void sendDlqFeedback(recommendation, env);
          void decrementQueueDepth(env, recommendation?.tenantId);
          message.ack();
          continue;
        }

        message.retry();
      }
    }
  },
};

async function dispatchRecommendation(
  recommendation: PendingRecommendation,
  env: DispatcherEnv,
): Promise<void> {
  console.log(
    JSON.stringify({
      type: "dispatch_attempted",
      correlationId: recommendation.correlationId,
      actionType: recommendation.action.type,
    }),
  );

    const intent = recommendation.action.type;
    const resolvedChannel = CHANNEL_POLICY[intent] ?? null;

    if (intent === "nurture" || intent === "activate" || intent === "convert" || intent === "recover") {
      await sendToVisibilityMarketing(recommendation, env, resolvedChannel!);
      return;
    }
    if (intent === "escalate") {
      await storeEscalation(recommendation, env);
      return;
    }
    // pause | wait → no-op: recommendation is recorded but no downstream action taken
}

async function sendToVisibilityMarketing(
  recommendation: PendingRecommendation,
  env: DispatcherEnv,
    resolvedChannel: string,
): Promise<void> {
  if (!env.VISIBILITY_MARKETING_URL || !env.INTERNAL_SECRET) {
    throw new Error("missing_dispatch_target_config");
  }

  const response = await fetch(env.VISIBILITY_MARKETING_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": env.INTERNAL_SECRET,
      "x-tenant-id": recommendation.tenantId,
      "x-correlation-id": recommendation.correlationId,
    },
    body: JSON.stringify({
        recommendation: {
          ...recommendation,
          action: { ...recommendation.action, type: resolvedChannel },
        },
      source: "growth-agent-dispatcher",
    }),
  });

  if (!response.ok) {
    throw new Error(`visibility_marketing_http_${response.status}`);
  }
}

async function storeEscalation(
  recommendation: PendingRecommendation,
  env: DispatcherEnv,
): Promise<void> {
  if (!env.OUTCOME_DB) {
    return;
  }

  await env.OUTCOME_DB.prepare(
    `INSERT INTO recommendation_log
     (id, correlation_id, tenant_id, subject_id, capability, action_type, confidence, risk_level, enqueued_at, expires_at, source)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(correlation_id) DO NOTHING`,
  )
    .bind(
      crypto.randomUUID(),
      recommendation.correlationId,
      recommendation.tenantId,
      recommendation.subjectId,
      recommendation.capability,
      recommendation.action.type,
      recommendation.confidence,
      recommendation.riskLevel,
      recommendation.enqueuedAt,
      recommendation.expiresAt,
      "proactive",
    )
    .run();
}

async function markDispatched(env: DispatcherEnv, correlationId: string): Promise<void> {
  if (!env.OUTCOME_DB) {
    return;
  }

  await env.OUTCOME_DB.prepare(
    `UPDATE recommendation_log SET dispatched_at = ?1 WHERE correlation_id = ?2`,
  )
    .bind(new Date().toISOString(), correlationId)
    .run();
}

async function sendDlqFeedback(
  recommendation: PendingRecommendation,
  env: DispatcherEnv,
): Promise<void> {
  if (!env.GROWTH_AGENT || !env.INTERNAL_SECRET || !recommendation?.correlationId) {
    return;
  }
  try {
    await env.GROWTH_AGENT.fetch("https://growth-agent/internal/outcome-feedback", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": env.INTERNAL_SECRET,
        "x-tenant-id": recommendation.tenantId,
        "x-correlation-id": recommendation.correlationId,
      },
      body: JSON.stringify({
        correlationId: recommendation.correlationId,
        tenantId: recommendation.tenantId,
        subjectId: recommendation.subjectId,
        actionTaken: "dlq_dropped",
        outcomeMetric: "dlq_dropped",
        delta: -1.0,
        observedAt: new Date().toISOString(),
      }),
    });
  } catch {
    // non-fatal
  }
}

async function decrementQueueDepth(
  env: DispatcherEnv,
  tenantId: string | undefined,
): Promise<void> {
  if (!env.TENANT_REGISTRY_KV || !tenantId) {
    return;
  }
  const depthKey = `queue-depth:${tenantId}`;
  const raw = await env.TENANT_REGISTRY_KV.get(depthKey);
  const current = Number.parseInt(raw ?? "0", 10);
  const next = Math.max(0, (Number.isFinite(current) ? current : 0) - 1);
  if (next > 0) {
    await env.TENANT_REGISTRY_KV.put(depthKey, String(next), { expirationTtl: 90000 });
  } else {
    await env.TENANT_REGISTRY_KV.delete(depthKey);
  }
}
