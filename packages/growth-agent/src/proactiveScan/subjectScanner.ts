import type { PendingRecommendation, RuntimeConfig, TenantSubject } from "../types";
import { handleGrowthNextAction } from "../capabilities/growthNextAction";
import type { LlmAdapter } from "../types";

function deterministicHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function assignArm(subjectId: string, experimentId: string, controlPct: number): "treatment" | "control" {
  return (deterministicHash(subjectId + experimentId) % 100) < controlPct ? "control" : "treatment";
}

export async function scanSubjectForRecommendation(
  subject: TenantSubject,
  deps: { llm: LlmAdapter; config: RuntimeConfig },
  experiment?: { experimentId: string; controlPct: number },
): Promise<PendingRecommendation | null> {
  const result = await handleGrowthNextAction(
    {
      tenantId: subject.tenantId,
      subjectId: subject.subjectId,
      signals: subject.signals,
      outputLocale: "en",
    },
    deps,
  );

  if (result.data.action.type === "wait") {
    return null;
  }

  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 3600 * 1000);
    const arm = experiment
      ? assignArm(subject.subjectId, experiment.experimentId, experiment.controlPct)
      : undefined;
  return {
    tenantId: subject.tenantId,
    subjectId: subject.subjectId,
    capability: "growth-next-action",
    action: result.data.action,
    confidence: result.data.confidence,
    riskLevel: result.data.riskLevel,
    correlationId: `${subject.tenantId}:${crypto.randomUUID()}`,
    sourcePromptVersion: result.promptVersion,
    enqueuedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
      experimentId: experiment?.experimentId,
      arm,
  };
}
