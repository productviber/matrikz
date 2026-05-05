import { PendingRecommendationSchema, type PendingRecommendation } from "@clodo/growth-agent-contracts";
import type { GrowthAgentEnv } from "../types";
import { recommendationExists, saveRecommendation } from "./recommendationStore";

const FALLBACK_PREFIX = "pending-recommendation";

export async function enqueueRecommendation(
  env: GrowthAgentEnv,
  recommendation: PendingRecommendation,
  maxPendingPerTenant = 5,
): Promise<{ enqueued: boolean; reason: string }> {
  const valid = PendingRecommendationSchema.safeParse(recommendation);
  if (!valid.success) {
    return { enqueued: false, reason: "invalid_recommendation" };
  }

  const exists = await recommendationExists(
    env,
    recommendation.tenantId,
    recommendation.subjectId,
    new Date().toISOString(),
  );
  if (exists) {
    return { enqueued: false, reason: "duplicate_unexpired" };
  }

  if (env.TENANT_REGISTRY_KV && maxPendingPerTenant > 0) {
    const depthKey = `queue-depth:${recommendation.tenantId}`;
    const raw = await env.TENANT_REGISTRY_KV.get(depthKey);
    const depth = Number.parseInt(raw ?? "0", 10);
    if (Number.isFinite(depth) && depth >= maxPendingPerTenant) {
      console.log(
        JSON.stringify({
          type: "enqueue_rejected_queue_saturated",
          tenantId: recommendation.tenantId,
          depth,
          maxPendingPerTenant,
        }),
      );
      return { enqueued: false, reason: "tenant_queue_saturated" };
    }
  }

  await saveRecommendation(env, recommendation, "proactive");

  if (env.RECOMMENDATION_QUEUE) {
    await env.RECOMMENDATION_QUEUE.send(recommendation);
    void incrementQueueDepth(env, recommendation.tenantId);
    return { enqueued: true, reason: "queued" };
  }

  if (env.TENANT_REGISTRY_KV) {
    await env.TENANT_REGISTRY_KV.put(
      `${FALLBACK_PREFIX}:${recommendation.tenantId}:${recommendation.correlationId}`,
      JSON.stringify(recommendation),
      { expirationTtl: 86400 },
    );
    void incrementQueueDepth(env, recommendation.tenantId);
    return { enqueued: true, reason: "kv_fallback" };
  }

  return { enqueued: false, reason: "no_queue_or_kv" };
}

async function incrementQueueDepth(env: GrowthAgentEnv, tenantId: string): Promise<void> {
  if (!env.TENANT_REGISTRY_KV) return;
  const depthKey = `queue-depth:${tenantId}`;
  const raw = await env.TENANT_REGISTRY_KV.get(depthKey);
  const current = Number.parseInt(raw ?? "0", 10);
  const next = (Number.isFinite(current) ? current : 0) + 1;
  await env.TENANT_REGISTRY_KV.put(depthKey, String(next), { expirationTtl: 90000 });
}
