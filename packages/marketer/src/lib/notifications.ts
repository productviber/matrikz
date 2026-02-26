/**
 * Notification System — Slack, Discord, and internal logging.
 */

import type { Env } from '../types';
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const success = res.ok;
    await logNotification(env, 'slack', 'general', message, success);
    return success;
  } catch (err) {
    console.error('[Slack] Error:', err);
    await logNotification(env, 'slack', 'general', message, false);
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const success = res.ok;
    await logNotification(env, 'discord', 'general', message, success);
    return success;
  } catch (err) {
    console.error('[Discord] Error:', err);
    await logNotification(env, 'discord', 'general', message, false);
    return false;
  }
}

// ─── Pre-built Notification Messages ────────────────────────────────────────

export async function notifyNewConversion(
  env: Env,
  data: { userId: string; plan: string; amountCents: number; gateway: string }
): Promise<void> {
  const msg = `💰 **New Conversion!**\nPlan: ${data.plan}\nAmount: ${formatCents(data.amountCents)}\nGateway: ${data.gateway}`;

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
  const msg = `🤝 **Affiliate Conversion!**\nAffiliate: ${data.affiliateCode}\nPlan: ${data.plan}\nSale: ${formatCents(data.amountCents)}\nCommission: ${formatCents(data.commissionCents)}`;

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
  const msg = `🏆 **Affiliate Tier Upgrade!**\nAffiliate: ${affiliateCode}\nNew Tier: ${tierName} (${(rate * 100).toFixed(0)}% commission)`;

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
  const msg = `🎯 **Affiliate Milestone!**\nAffiliate: ${affiliateCode}\nTotal Earnings: ${formatCents(milestoneCents)}`;

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
  const msg = `💸 **Payout Batch Completed!**\nBatch #${batchId}\nTotal: ${formatCents(totalCents)}\nAffiliates: ${affiliateCount}`;

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
      [channel, eventType, summary.slice(0, 500), success ? 'sent' : 'failed']
    );
  } catch {
    // Don't let logging failures break the flow
  }
}
