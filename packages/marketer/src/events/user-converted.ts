/**
 * User Converted Event Handler
 *
 * Triggered when: Any user completes a purchase (regardless of affiliate).
 *
 * Responsibilities:
 * 1. Trigger post-purchase onboarding email sequence
 * 2. Move user from "lead" to "customer" in CRM
 * 3. If user was on trial, cancel trial-expiry reminders
 * 4. Track MRR/ARR growth metrics
 * 5. Trigger internal Slack/Discord notification
 */

import type { Env, UserConvertedData } from '../types';
import { hashEmail, formatCents } from '../lib/db';
import { enrollInSequences, cancelPendingEmails } from '../lib/email';
import { markAsCustomer, getContact, updateMrrSnapshot } from '../lib/crm';
import { notifyNewConversion } from '../lib/notifications';

export async function handleUserConverted(
  env: Env,
  data: UserConvertedData,
  timestamp: string
): Promise<void> {
  const { userId, purchaseType, plan, amountCents, gateway } = data;

  // Hash once and reuse throughout the handler
  const hashedUserId = await hashEmail(userId);

  console.log(
    `[UserConverted] user=${hashedUserId} ` +
    `type=${purchaseType} plan=${plan} amount=${formatCents(amountCents)} gateway=${gateway}`
  );

  // ── 1. Check existing contact state (for trial detection) ──
  const existingContact = await getContact(env, userId);
  const wasTrial = existingContact?.status === 'trial';
  const wasLead = !existingContact || existingContact.status === 'lead';

  // ── 2. Move user to "customer" in CRM ──
  await markAsCustomer(env, userId, plan, gateway, amountCents);

  // ── 3. If was on trial, cancel trial-expiry reminders ──
  if (wasTrial) {
    const cancelled = await cancelPendingEmails(env, userId, 'trial.expiring');
    if (cancelled > 0) {
      console.log(`[UserConverted] Cancelled ${cancelled} trial-expiry emails for ${hashedUserId}`);
    }
  }

  // ── 4. Enroll in post-purchase onboarding email sequence ──
  const enrolledSteps = await enrollInSequences(env, userId, 'user.converted', {
    plan,
    purchaseType,
    amountCents,
    gateway,
    formattedAmount: formatCents(amountCents),
    isUpgrade: wasTrial ? 'true' : 'false',
  });
  console.log(`[UserConverted] Enrolled in ${enrolledSteps} email steps`);

  // ── 5. Track MRR/ARR growth metrics ──
  await updateMrrSnapshot(env, amountCents, plan);

  // ── 6. Store conversion metadata in KV for quick access ──
  const kvKey = `user-conversion:${userId}`;
  await env.KV_MARKETING.put(
    kvKey,
    JSON.stringify({
      purchaseType,
      plan,
      amountCents,
      gateway,
      convertedAt: timestamp,
      previousStatus: existingContact?.status ?? 'unknown',
    }),
    { expirationTtl: 365 * 86_400 } // 1 year
  );

  // ── 7. Increment daily conversion counter in KV ──
  const todayKey = new Date().toISOString().slice(0, 10);
  const counterKey = `daily-conversions:${todayKey}`;
  const currentCount = parseInt(await env.KV_MARKETING.get(counterKey) ?? '0', 10);
  await env.KV_MARKETING.put(counterKey, String(currentCount + 1), {
    expirationTtl: 90 * 86_400, // 90 days retention
  });

  // Also track daily revenue
  const revenueKey = `daily-revenue:${todayKey}`;
  const currentRevenue = parseInt(await env.KV_MARKETING.get(revenueKey) ?? '0', 10);
  await env.KV_MARKETING.put(revenueKey, String(currentRevenue + amountCents), {
    expirationTtl: 90 * 86_400,
  });

  // ── 8. Send real-time notification to team ──
  await notifyNewConversion(env, { userId: hashedUserId, plan, amountCents, gateway });

  console.log(`[UserConverted] Completed processing for ${hashedUserId}`);
}
