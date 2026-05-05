import type { GrowthAgentEnv, RuntimeConfig } from "../types";
import type { LlmAdapter } from "../types";
import { enqueueRecommendation } from "../queue/recommendationQueueProducer";
import { listStaleTenantSubjects, markSubjectScanned } from "./tenantRegistryClient";
import { scanSubjectForRecommendation } from "./subjectScanner";

export interface ProactiveScanResult {
  scanned: number;
  queued: number;
  failed: number;
  durationMs: number;
  batchLimitReached: boolean;
}

export async function runProactiveScanJob(
  env: GrowthAgentEnv,
  deps: { llm: LlmAdapter; config: RuntimeConfig },
): Promise<ProactiveScanResult> {
  const started = Date.now();
  const subjects = await listStaleTenantSubjects(env);

  console.log(
    JSON.stringify({
      type: "proactive_scan_started",
      subjects: subjects.length,
    }),
  );

  if (subjects.length > 500) {
    console.log(
      JSON.stringify({
        type: "proactive_scan_runaway_warning",
        subjects: subjects.length,
        threshold: 500,
      }),
    );
  }

  let queued = 0;
  let failed = 0;
  let scanned = 0;

  for (const subject of subjects) {
    if (queued >= deps.config.proactiveScanBatchSize) {
      console.log(
        JSON.stringify({
          type: "proactive_scan_batch_limit_reached",
          batchSize: deps.config.proactiveScanBatchSize,
          queued,
        }),
      );
      break;
    }
    try {
      const recommendation = await scanSubjectForRecommendation(subject, deps);
      if (recommendation) {
        const enqueueResult = await enqueueRecommendation(env, recommendation, deps.config.maxPendingPerTenant);
        if (enqueueResult.enqueued) {
          queued += 1;
        }
      }
      await markSubjectScanned(env, subject, deps.config.proactiveScanCooldownHours);
      scanned += 1;
      console.log(
        JSON.stringify({
          type: "proactive_scan_subject_processed",
          tenantId: subject.tenantId,
          subjectId: subject.subjectId,
        }),
      );
    } catch (error) {
      scanned += 1;
      failed += 1;
      console.log(
        JSON.stringify({
          type: "proactive_scan_subject_failed",
          tenantId: subject.tenantId,
          subjectId: subject.subjectId,
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }

  const result = {
    scanned,
    queued,
    failed,
    durationMs: Date.now() - started,
    batchLimitReached: queued >= deps.config.proactiveScanBatchSize,
  };

  console.log(JSON.stringify({ type: "proactive_scan_completed", ...result }));
  return result;
}
