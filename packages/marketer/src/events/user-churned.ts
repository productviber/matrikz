/**
 * User Churned Event Handler
 *
 * Triggered when: A user cancels their subscription or is marked as churned
 * in visibility-analytics.
 *
 * Responsibilities:
 * 1. Update contact status to "churned" in the marketing CRM
 * 2. Record churn metadata (previous plan, days active)
 * 3. Enroll in win-back email sequence (trigger: user.churned)
 * 4. Increment daily churn counter in KV for admin dashboards
 * 5. Update MRR snapshot (decrement for lost revenue)
 * 6. Send admin notification (Slack/Discord)
 */

import type { Env, UserChurnedData } from '../types';
import { KV_PREFIX, TTL, CONTACT_STATUS, EVENT_TYPES } from '../constants';
import { upsertContact } from '../lib/crm';
import { enrollInSequences } from '../lib/email';
import { execute, now, todayKey, hashEmail } from '../lib/db';
import { sendSlackNotification, sendDiscordNotification } from '../lib/notifications';

export async function handleUserChurned(
  env: Env,
  data: UserChurnedData,
  timestamp: string
): Promise<void> {
  const { userId, previousPlan, daysActive, lastActivity } = data;
  const hashedUserId = await hashEmail(userId);

  console.log(
    `[UserChurned] user=${hashedUserId} previousPlan=${previousPlan} ` +
    `daysActive=${daysActive} lastActivity=${lastActivity}`
  );

  // ── 1. Update CRM contact status to churned ──
  await upsertContact(env, userId, {
    status: CONTACT_STATUS.CHURNED,
    metadata: JSON.stringify({
      churnedAt: timestamp,
      previousPlan,
      daysActive,
      lastActivity,
    }),
  });

  // ── 2. Enroll in win-back drip sequence ──
  await enrollInSequences(env, userId, EVENT_TYPES.USER_CHURNED, {
    previousPlan,
    daysActive,
  }).catch((err) => {
    console.error('[UserChurned] Sequence enrollment error:', err);
  });

  // ── 3. Increment daily churn counter ──
  const today = todayKey();
  const counterKey = `${KV_PREFIX.DAILY_EVENTS}churn:${today}`;
  const current = parseInt(await env.KV_MARKETING.get(counterKey) ?? '0', 10);
  await env.KV_MARKETING.put(counterKey, String(current + 1), {
    expirationTtl: TTL.DAYS_7,
  });

  // ── 4. Update MRR snapshot (decrement churned_customers) ──
  await execute(
    env.DB,
    `UPDATE mrr_snapshots SET churned_customers = churned_customers + 1
     WHERE date_key = ?`,
    [today]
  ).catch((err) => {
    console.error('[UserChurned] MRR snapshot update error:', err);
  });

  // ── 5. Admin notifications ──
  const message = `⚠️ **User Churned**\nPlan: ${previousPlan}\nDays Active: ${daysActive}`;
  await Promise.allSettled([
    sendSlackNotification(env, message),
    sendDiscordNotification(env, message),
  ]);

  console.log(`[UserChurned] Completed processing for ${hashedUserId}`);
}
