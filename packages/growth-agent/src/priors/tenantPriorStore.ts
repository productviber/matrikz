import { TenantPriorSchema, type TenantPrior } from "@clodo/growth-agent-contracts";
import type { GrowthAgentEnv } from "../types";

function priorKey(tenantId: string): string {
  return `prior:${tenantId}`;
}

function priorAuditKey(tenantId: string, at: string): string {
  return `prior-audit:${tenantId}:${at}`;
}

export async function getTenantPrior(env: GrowthAgentEnv, tenantId: string): Promise<TenantPrior | null> {
  if (!env.TENANT_PRIOR_KV) {
    return null;
  }
  const raw = await env.TENANT_PRIOR_KV.get(priorKey(tenantId));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const valid = TenantPriorSchema.safeParse(parsed);
    return valid.success ? valid.data : null;
  } catch {
    return null;
  }
}

export async function putTenantPrior(
  env: GrowthAgentEnv,
  tenantId: string,
  prior: TenantPrior,
  ttlDays: number,
  reason: string,
  auditSampleRate = 0.1,
): Promise<void> {
  if (!env.TENANT_PRIOR_KV) {
    return;
  }
  const at = new Date().toISOString();
  const payload = JSON.stringify({ ...prior, updatedAt: at });
  await env.TENANT_PRIOR_KV.put(priorKey(tenantId), payload, {
    expirationTtl: ttlDays * 86400,
  });

  await env.TENANT_PRIOR_KV.put(
    priorAuditKey(tenantId, at),
    JSON.stringify({ tenantId, reason, updatedAt: at, prior }),
    { expirationTtl: ttlDays * 86400 },
  );

  if (env.OUTCOME_DB) {
    if (Math.random() < auditSampleRate) {
      await env.OUTCOME_DB.prepare(
        `INSERT INTO prior_audit_log (tenant_id, field, old_value, new_value, reason, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
        .bind(tenantId, "full", "{}", payload, reason, at)
        .run();
    }
  }
}
