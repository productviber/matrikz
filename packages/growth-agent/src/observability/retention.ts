import type { GrowthAgentEnv } from "../types";

export async function cleanupRetentionData(env: GrowthAgentEnv, retentionDays: number): Promise<void> {
  if (!env.OUTCOME_DB) {
    return;
  }

  const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000).toISOString();

  await env.OUTCOME_DB.prepare(`DELETE FROM outcome_records WHERE created_at < ?1`).bind(cutoff).run();
  await env.OUTCOME_DB.prepare(`DELETE FROM recommendation_log WHERE enqueued_at < ?1`).bind(cutoff).run();

  console.log(
    JSON.stringify({
      type: "retention_cleanup_completed",
      retentionDays,
      cutoff,
    }),
  );
}
