/**
 * Plan Lifecycle Event Handlers
 *
 * Handles plan.upgraded and plan.downgraded events emitted by
 * the analytics worker when a user changes billing tiers.
 *
 * plan.upgraded responsibilities:
 * 1. Update CRM plan + status in marketing_contacts
 * 2. Cancel any pending win-back / trial-expiry emails
 * 3. Enroll in upgrade-success email sequence
 * 4. Track MRR/ARR delta in mrr_snapshots
 * 5. Increment daily upgrade counter in KV
 * 6. Notify team via Slack/Discord
 *
 * plan.downgraded responsibilities:
 * 1. Update CRM plan in marketing_contacts
 * 2. Enroll in retention / save email sequence
 * 3. Track MRR/ARR delta in mrr_snapshots (negative)
 * 4. Increment daily downgrade counter in KV
 * 5. Notify team via Slack/Discord
 */

import type { Env, PlanUpgradedData, PlanDowngradedData } from '../types';
import { KV_PREFIX, TTL, CONTACT_STATUS, EVENT_TYPES } from '../constants';
import { hashEmail, formatCents } from '../lib/db';
import { enrollInSequences, cancelPendingEmails } from '../lib/email';
import { upsertContact, getContact, updateMrrSnapshot } from '../lib/crm';
import { sendSlackNotification, sendDiscordNotification } from '../lib/notifications';

// ─── Plan Upgraded ──────────────────────────────────────────────────────────

export async function handlePlanUpgraded(
  env: Env,
  data: PlanUpgradedData,
  timestamp: string
): Promise<void> {
  const { userId, previousPlan, newPlan, amountCents, gateway, period } = data;
  const hashedUserId = await hashEmail(userId);

  console.log(
    `[PlanUpgraded] user=${hashedUserId} ` +
    `${previousPlan} → ${newPlan} amount=${formatCents(amountCents)} gateway=${gateway} period=${period}`
  );

  // ── 1. Update CRM — mark as customer with new plan ──
  const existingContact = await getContact(env, userId);
  await upsertContact(env, userId, {
    status: CONTACT_STATUS.CUSTOMER,
    plan: newPlan,
    gateway,
  });

  // ── 2. Cancel pending win-back and trial-expiry emails ──
  const cancelledWinBack = await cancelPendingEmails(env, userId, EVENT_TYPES.USER_CHURNED);
  const cancelledTrial = await cancelPendingEmails(env, userId, EVENT_TYPES.TRIAL_EXPIRING);
  if (cancelledWinBack > 0 || cancelledTrial > 0) {
    console.log(
      `[PlanUpgraded] Cancelled ${cancelledWinBack} win-back + ${cancelledTrial} trial emails for ${hashedUserId}`
    );
  }

  // ── 3. Enroll in upgrade-success email sequence ──
  const enrolledSteps = await enrollInSequences(env, userId, EVENT_TYPES.PLAN_UPGRADED, {
    previousPlan,
    newPlan,
    amountCents,
    gateway,
    period,
    formattedAmount: formatCents(amountCents),
  });
  console.log(`[PlanUpgraded] Enrolled in ${enrolledSteps} email steps`);

  // ── 4. Update MRR snapshot ──
  await updateMrrSnapshot(env, amountCents, period);

  // ── 5. Store upgrade metadata in KV ──
  const kvKey = `${KV_PREFIX.USER_CONVERSION}upgrade:${userId}`;
  await env.KV_MARKETING.put(
    kvKey,
    JSON.stringify({
      previousPlan,
      newPlan,
      amountCents,
      gateway,
      period,
      upgradedAt: timestamp,
      previousStatus: existingContact?.status ?? 'unknown',
    }),
    { expirationTtl: TTL.YEAR_1 }
  );

  // ── 6. Increment daily upgrade counter ──
  const todayKey = new Date().toISOString().slice(0, 10);
  const counterKey = `${KV_PREFIX.DAILY_EVENTS}upgrades:${todayKey}`;
  const current = parseInt(await env.KV_MARKETING.get(counterKey) ?? '0', 10);
  await env.KV_MARKETING.put(counterKey, String(current + 1), {
    expirationTtl: TTL.DAYS_90,
  });

  // ── 7. Notify team ──
  const msg =
    `📈 **Plan Upgrade!**\n` +
    `Plan: ${previousPlan} → ${newPlan}\n` +
    `Amount: ${formatCents(amountCents)} (${period})\n` +
    `Gateway: ${gateway}`;

  await Promise.allSettled([
    sendSlackNotification(env, msg),
    sendDiscordNotification(env, msg),
  ]);

  console.log(`[PlanUpgraded] Completed processing for ${hashedUserId}`);
}

// ─── Plan Downgraded ────────────────────────────────────────────────────────

export async function handlePlanDowngraded(
  env: Env,
  data: PlanDowngradedData,
  timestamp: string
): Promise<void> {
  const { userId, previousPlan, newPlan, amountCents, gateway, period } = data;
  const hashedUserId = await hashEmail(userId);

  console.log(
    `[PlanDowngraded] user=${hashedUserId} ` +
    `${previousPlan} → ${newPlan} amount=${formatCents(amountCents)} gateway=${gateway} period=${period}`
  );

  // ── 1. Update CRM — keep as customer but with downgraded plan ──
  await upsertContact(env, userId, {
    plan: newPlan,
    gateway,
  });

  // ── 2. Enroll in retention / save email sequence ──
  const enrolledSteps = await enrollInSequences(env, userId, EVENT_TYPES.PLAN_DOWNGRADED, {
    previousPlan,
    newPlan,
    amountCents,
    gateway,
    period,
    formattedAmount: formatCents(amountCents),
  });
  console.log(`[PlanDowngraded] Enrolled in ${enrolledSteps} email steps`);

  // ── 3. Store downgrade metadata in KV ──
  const kvKey = `${KV_PREFIX.USER_CONVERSION}downgrade:${userId}`;
  await env.KV_MARKETING.put(
    kvKey,
    JSON.stringify({
      previousPlan,
      newPlan,
      amountCents,
      gateway,
      period,
      downgradedAt: timestamp,
    }),
    { expirationTtl: TTL.YEAR_1 }
  );

  // ── 4. Increment daily downgrade counter ──
  const todayKey = new Date().toISOString().slice(0, 10);
  const counterKey = `${KV_PREFIX.DAILY_EVENTS}downgrades:${todayKey}`;
  const current = parseInt(await env.KV_MARKETING.get(counterKey) ?? '0', 10);
  await env.KV_MARKETING.put(counterKey, String(current + 1), {
    expirationTtl: TTL.DAYS_90,
  });

  // ── 5. Notify team ──
  const msg =
    `⚠️ **Plan Downgrade**\n` +
    `Plan: ${previousPlan} → ${newPlan}\n` +
    `Amount: ${formatCents(amountCents)} (${period})\n` +
    `Gateway: ${gateway}`;

  await Promise.allSettled([
    sendSlackNotification(env, msg),
    sendDiscordNotification(env, msg),
  ]);

  console.log(`[PlanDowngraded] Completed processing for ${hashedUserId}`);
}
