/**
 * Trial Expiring Event Handler
 *
 * Triggered by the analytics worker's scheduled cron when a user's
 * trial is within 3 days of expiration.
 *
 * Responsibilities:
 * 1. Update CRM metadata with expiry info
 * 2. Enroll in trial-expiry urgency email sequence
 * 3. Store urgency data in KV for quick access
 * 4. Notify team if trial expires within 1 day
 */

import type { Env, TrialExpiringData } from '../types';
import { KV_PREFIX, TTL, CONTACT_STATUS, EVENT_TYPES } from '../constants';
import { hashEmail } from '../lib/db';
import { enrollInSequences } from '../lib/email';
import { upsertContact, getContact } from '../lib/crm';
import { sendSlackNotification, sendDiscordNotification } from '../lib/notifications';

export async function handleTrialExpiring(
  env: Env,
  data: TrialExpiringData,
  timestamp: string
): Promise<void> {
  const { userId, plan, daysRemaining, expiresAt } = data;
  const hashedUserId = await hashEmail(userId);

  console.log(
    `[TrialExpiring] user=${hashedUserId} plan=${plan} daysRemaining=${daysRemaining} expiresAt=${expiresAt}`
  );

  // ── 1. Ensure CRM contact exists as trial ──
  const existing = await getContact(env, userId);
  if (!existing) {
    // Contact doesn't exist yet — create as trial
    await upsertContact(env, userId, {
      status: CONTACT_STATUS.TRIAL,
      plan,
    });
  } else if (existing.status === CONTACT_STATUS.CUSTOMER) {
    // Already a customer — skip trial expiry flow
    console.log(`[TrialExpiring] ${hashedUserId} is already a customer, skipping`);
    return;
  }

  // ── 2. Update CRM metadata with expiry context ──
  const existingMeta = existing?.metadata ? JSON.parse(existing.metadata) : {};
  await upsertContact(env, userId, {
    status: existing?.status ?? CONTACT_STATUS.TRIAL,
    plan,
    metadata: JSON.stringify({
      ...existingMeta,
      trialDaysRemaining: daysRemaining,
      trialExpiresAt: expiresAt,
      trialWarningAt: timestamp,
    }),
  });

  // ── 3. Enroll in trial-expiry urgency email sequence ──
  const enrolledSteps = await enrollInSequences(env, userId, EVENT_TYPES.TRIAL_EXPIRING, {
    plan,
    daysRemaining,
    expiresAt,
  });
  console.log(`[TrialExpiring] Enrolled in ${enrolledSteps} email steps`);

  // ── 4. Store trial urgency data in KV ──
  const kvKey = `${KV_PREFIX.DAILY_EVENTS}trial-expiring:${userId}`;
  await env.KV_MARKETING.put(
    kvKey,
    JSON.stringify({
      plan,
      daysRemaining,
      expiresAt,
      warnedAt: timestamp,
    }),
    { expirationTtl: TTL.DAYS_7 }
  );

  // ── 5. Increment daily trial-expiring counter ──
  const todayKey = new Date().toISOString().slice(0, 10);
  const counterKey = `${KV_PREFIX.DAILY_EVENTS}trials-expiring:${todayKey}`;
  const current = parseInt(await env.KV_MARKETING.get(counterKey) ?? '0', 10);
  await env.KV_MARKETING.put(counterKey, String(current + 1), {
    expirationTtl: TTL.DAYS_90,
  });

  // ── 6. Notify team if expiry is imminent (≤ 1 day) ──
  if (daysRemaining <= 1) {
    const msg =
      `⏳ **Trial Expiring Today!**\n` +
      `User: ${hashedUserId}\n` +
      `Plan: ${plan}\n` +
      `Expires: ${expiresAt}`;

    await Promise.allSettled([
      sendSlackNotification(env, msg),
      sendDiscordNotification(env, msg),
    ]);
  }

  console.log(`[TrialExpiring] Completed processing for ${hashedUserId}`);
}
