/**
 * Insight Generated Event Handler
 *
 * Triggered by the analytics worker's scheduled cron when the insights
 * engine detects new insights for a site.
 *
 * Responsibilities:
 * 1. Update CRM engagement metadata (latest insight info)
 * 2. Enroll in engagement email sequences matching insight.generated
 * 3. Increment daily insight counter in KV
 *
 * Note: This is a high-frequency event (fires per-site per cron).
 * Keep processing lightweight — no team notifications (too noisy).
 */

import type { Env, InsightGeneratedData } from '../types';
import { KV_PREFIX, TTL, EVENT_TYPES } from '../constants';
import { hashEmail } from '../lib/db';
import { enrollInSequences } from '../lib/email';
import { getContact, upsertContact } from '../lib/crm';

export async function handleInsightGenerated(
  env: Env,
  data: InsightGeneratedData,
  timestamp: string
): Promise<void> {
  const { userId, insightCount, topInsightType, severity } = data;
  const hashedUserId = await hashEmail(userId);

  console.log(
    `[InsightGenerated] site=${hashedUserId} count=${insightCount} ` +
    `topType=${topInsightType} severity=${severity}`
  );

  // ── 1. Update CRM engagement metadata ──
  const existing = await getContact(env, userId);
  if (existing) {
    const existingMeta = existing.metadata ? JSON.parse(existing.metadata) : {};
    const totalInsights = (existingMeta.totalInsightsReceived ?? 0) + insightCount;

    await upsertContact(env, userId, {
      metadata: JSON.stringify({
        ...existingMeta,
        totalInsightsReceived: totalInsights,
        lastInsightType: topInsightType,
        lastInsightSeverity: severity,
        lastInsightAt: timestamp,
      }),
    });
  }

  // ── 2. Enroll in engagement sequences if applicable ──
  const enrolledSteps = await enrollInSequences(env, userId, EVENT_TYPES.INSIGHT_GENERATED, {
    insightCount,
    topInsightType,
    severity,
  });
  if (enrolledSteps > 0) {
    console.log(`[InsightGenerated] Enrolled in ${enrolledSteps} email steps`);
  }

  // ── 3. Increment daily insight counter ──
  const todayKey = new Date().toISOString().slice(0, 10);
  const counterKey = `${KV_PREFIX.DAILY_EVENTS}insights:${todayKey}`;
  const current = parseInt(await env.KV_MARKETING.get(counterKey) ?? '0', 10);
  await env.KV_MARKETING.put(counterKey, String(current + insightCount), {
    expirationTtl: TTL.DAYS_90,
  });

  console.log(`[InsightGenerated] Completed processing for ${hashedUserId}`);
}
