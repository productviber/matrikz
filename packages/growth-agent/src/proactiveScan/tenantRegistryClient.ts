import { TenantRegistryMetaSchema, TenantSubjectSchema, type TenantSubject } from "@clodo/growth-agent-contracts";
import type { GrowthAgentEnv } from "../types";

export async function listStaleTenantSubjects(env: GrowthAgentEnv): Promise<TenantSubject[]> {
  if (!env.TENANT_REGISTRY_KV) {
    return [];
  }

  const list = await env.TENANT_REGISTRY_KV.list({ prefix: "tenant:" });
  const tenantKeys = list.keys.filter((key) => key.name.includes(":subject:"));
  const metaCache = new Map<string, boolean>();
  const out: TenantSubject[] = [];

  for (const key of tenantKeys) {
    const parts = key.name.split(":");
    if (parts.length < 4 || parts[2] !== "subject") {
      continue;
    }
    const tenantId = parts[1];

    if (!metaCache.has(tenantId)) {
      const metaRaw = await env.TENANT_REGISTRY_KV.get(`tenant-meta:${tenantId}`);
      let isActive: boolean;
      if (metaRaw) {
        const meta = TenantRegistryMetaSchema.safeParse(JSON.parse(metaRaw) as unknown);
        isActive = meta.success && meta.data.status === "active";
        if (!isActive) {
          console.log(
            JSON.stringify({
              type: "registry_tenant_skipped",
              tenantId,
              status: meta.success ? meta.data.status : "invalid_meta",
            }),
          );
        }
      } else {
        // No meta key — treat as active for backward compatibility; log for observability
        isActive = true;
        console.log(JSON.stringify({ type: "registry_tenant_no_meta", tenantId }));
      }
      metaCache.set(tenantId, isActive);
    }

    if (!metaCache.get(tenantId)) {
      continue;
    }

    const raw = await env.TENANT_REGISTRY_KV.get(key.name);
    if (!raw) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      const maybeArray = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of maybeArray) {
        const valid = TenantSubjectSchema.safeParse(item);
        if (!valid.success) {
          continue;
        }
        if (isActionable(valid.data)) {
          out.push(valid.data);
        }
      }
    } catch {
      continue;
    }
  }

  return out;
}

export async function registerTenantSubject(
  env: GrowthAgentEnv,
  subject: TenantSubject,
): Promise<{ registered: boolean; reason: string }> {
  const valid = TenantSubjectSchema.safeParse(subject);
  if (!valid.success) {
    console.log(
      JSON.stringify({
        type: "registry_write_rejected",
        reason: "schema_invalid",
        errors: valid.error.issues,
      }),
    );
    return { registered: false, reason: "schema_invalid" };
  }

  if (!env.TENANT_REGISTRY_KV) {
    return { registered: false, reason: "no_kv" };
  }

  const now = new Date().toISOString();
  const metaKey = `tenant-meta:${subject.tenantId}`;
  const existingMetaRaw = await env.TENANT_REGISTRY_KV.get(metaKey);

  if (!existingMetaRaw) {
    await env.TENANT_REGISTRY_KV.put(
      metaKey,
      JSON.stringify({ status: "active", enrolledAt: now, updatedAt: now }),
    );
  } else {
    try {
      const validMeta = TenantRegistryMetaSchema.safeParse(JSON.parse(existingMetaRaw) as unknown);
      if (validMeta.success && validMeta.data.status !== "active") {
        await env.TENANT_REGISTRY_KV.put(
          metaKey,
          JSON.stringify({ ...validMeta.data, status: "active", updatedAt: now }),
        );
      }
    } catch {
      await env.TENANT_REGISTRY_KV.put(
        metaKey,
        JSON.stringify({ status: "active", enrolledAt: now, updatedAt: now }),
      );
    }
  }

  await env.TENANT_REGISTRY_KV.put(
    `tenant:${subject.tenantId}:subject:${subject.subjectId}`,
    JSON.stringify(valid.data),
  );

  console.log(
    JSON.stringify({
      type: "registry_subject_registered",
      tenantId: subject.tenantId,
      subjectId: subject.subjectId,
    }),
  );
  return { registered: true, reason: "ok" };
}

export async function deregisterTenant(env: GrowthAgentEnv, tenantId: string): Promise<void> {
  if (!env.TENANT_REGISTRY_KV) {
    return;
  }

  const now = new Date().toISOString();
  const metaKey = `tenant-meta:${tenantId}`;
  const existingRaw = await env.TENANT_REGISTRY_KV.get(metaKey);

  try {
    const validMeta = TenantRegistryMetaSchema.safeParse(
      existingRaw ? (JSON.parse(existingRaw) as unknown) : null,
    );
    const enrolledAt = validMeta.success ? validMeta.data.enrolledAt : now;
    await env.TENANT_REGISTRY_KV.put(
      metaKey,
      JSON.stringify({ status: "churned", enrolledAt, updatedAt: now }),
    );
  } catch {
    await env.TENANT_REGISTRY_KV.put(
      metaKey,
      JSON.stringify({ status: "churned", enrolledAt: now, updatedAt: now }),
    );
  }

  console.log(JSON.stringify({ type: "registry_tenant_deregistered", tenantId }));
}

export async function markSubjectScanned(
  env: GrowthAgentEnv,
  subject: TenantSubject,
  cooldownHours: number,
): Promise<void> {
  if (!env.TENANT_REGISTRY_KV) {
    return;
  }

  const now = new Date();
  const cooldownUntil = new Date(now.getTime() + cooldownHours * 3600 * 1000).toISOString();

  await env.TENANT_REGISTRY_KV.put(
    `tenant:${subject.tenantId}:subject:${subject.subjectId}`,
    JSON.stringify({
      ...subject,
      lastScannedAt: now.toISOString(),
      cooldownUntil,
    }),
  );
}

function isActionable(subject: TenantSubject): boolean {
  const now = Date.now();
  const staleSince = Date.parse(subject.staleSince);
  if (Number.isNaN(staleSince) || staleSince > now) {
    return false;
  }

  if (!subject.cooldownUntil) {
    return true;
  }

  const cooldown = Date.parse(subject.cooldownUntil);
  return Number.isNaN(cooldown) || cooldown < now;
}
