/**
 * Notification System — Slack, Discord, and internal logging.
 */

import type { Env } from '../types';
import {
  CONTENT_TYPE_JSON,
  DEFAULTS,
  MAX_LENGTH,
  NOTIFICATION_CHANNEL,
  PAYOUT_STATUS,
  MESSAGES,
} from '../constants';
import { execute, formatCents } from './db';

// ─── Slack ──────────────────────────────────────────────────────────────────

export async function sendSlackNotification(
  env: Env,
  message: string,
  blocks?: unknown[]
): Promise<boolean> {
  if (!env.SLACK_WEBHOOK_URL) {
    console.log(`[Slack:Disabled] ${message}`);
    return false;
  }

  try {
    const payload: Record<string, unknown> = { text: message };
    if (blocks) payload.blocks = blocks;

    const res = await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': CONTENT_TYPE_JSON },
      body: JSON.stringify(payload),
    });

    const success = res.ok;
    await logNotification(env, NOTIFICATION_CHANNEL.SLACK, DEFAULTS.NOTIFICATION_EVENT_TYPE, message, success);
    return success;
  } catch (err) {
    console.error('[Slack] Error:', err);
    await logNotification(env, NOTIFICATION_CHANNEL.SLACK, DEFAULTS.NOTIFICATION_EVENT_TYPE, message, false);
    return false;
  }
}

// ─── Discord ────────────────────────────────────────────────────────────────

export async function sendDiscordNotification(
  env: Env,
  message: string,
  embeds?: unknown[]
): Promise<boolean> {
  if (!env.DISCORD_WEBHOOK_URL) {
    console.log(`[Discord:Disabled] ${message}`);
    return false;
  }

  try {
    const payload: Record<string, unknown> = { content: message };
    if (embeds) payload.embeds = embeds;

    const res = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': CONTENT_TYPE_JSON },
      body: JSON.stringify(payload),
    });

    const success = res.ok;
    await logNotification(env, NOTIFICATION_CHANNEL.DISCORD, DEFAULTS.NOTIFICATION_EVENT_TYPE, message, success);
    return success;
  } catch (err) {
    console.error('[Discord] Error:', err);
    await logNotification(env, NOTIFICATION_CHANNEL.DISCORD, DEFAULTS.NOTIFICATION_EVENT_TYPE, message, false);
    return false;
  }
}

// ─── Pre-built Notification Messages ────────────────────────────────────────

export async function notifyNewConversion(
  env: Env,
  data: { userId: string; plan: string; amountCents: number; gateway: string }
): Promise<void> {
  const msg = MESSAGES.notifications.newConversion(data.plan, formatCents(data.amountCents), data.gateway);

  await Promise.allSettled([
    sendSlackNotification(env, msg),
    sendDiscordNotification(env, msg),
  ]);
}

export async function notifyAffiliateConversion(
  env: Env,
  data: {
    affiliateCode: string;
    plan: string;
    amountCents: number;
    commissionCents: number;
  }
): Promise<void> {
  const msg = MESSAGES.notifications.affiliateConversion(data.affiliateCode, data.plan, formatCents(data.amountCents), formatCents(data.commissionCents));

  await Promise.allSettled([
    sendSlackNotification(env, msg),
    sendDiscordNotification(env, msg),
  ]);
}

export async function notifyTierUpgrade(
  env: Env,
  affiliateCode: string,
  tierName: string,
  rate: number
): Promise<void> {
  const msg = MESSAGES.notifications.tierUpgrade(affiliateCode, tierName, rate);

  await Promise.allSettled([
    sendSlackNotification(env, msg),
    sendDiscordNotification(env, msg),
  ]);
}

export async function notifyEarningsMilestone(
  env: Env,
  affiliateCode: string,
  milestoneCents: number
): Promise<void> {
  const msg = MESSAGES.notifications.earningsMilestone(affiliateCode, formatCents(milestoneCents));

  await Promise.allSettled([
    sendSlackNotification(env, msg),
    sendDiscordNotification(env, msg),
  ]);
}

export async function notifyPayoutCompleted(
  env: Env,
  batchId: number,
  totalCents: number,
  affiliateCount: number
): Promise<void> {
  const msg = MESSAGES.notifications.payoutCompleted(batchId, formatCents(totalCents), affiliateCount);

  await Promise.allSettled([
    sendSlackNotification(env, msg),
    sendDiscordNotification(env, msg),
  ]);
}

// ─── Logging ────────────────────────────────────────────────────────────────

async function logNotification(
  env: Env,
  channel: 'slack' | 'discord' | 'email',
  eventType: string,
  summary: string,
  success: boolean
): Promise<void> {
  try {
    await execute(
      env.DB,
      `INSERT INTO notification_log (channel, event_type, payload_summary, status)
       VALUES (?, ?, ?, ?)`,
      [channel, eventType, summary.slice(0, MAX_LENGTH.NOTIFICATION_SUMMARY), success ? PAYOUT_STATUS.SENT : PAYOUT_STATUS.FAILED]
    );
  } catch {
    // Don't let logging failures break the flow
  }
}
