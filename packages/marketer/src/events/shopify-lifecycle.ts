  /**
 * Shopify Lifecycle Event Handlers
 *
 * Handles events from the Shopify app node that flow through the
 * visibility-analytics event bus. These events arrive with
 * `data._sourceNode = 'shopify-app'` to distinguish from cockpit events.
 *
 * Events handled:
 *   user.app_installed    → New merchant installed the Shopify app
 *   user.app_uninstalled  → Merchant uninstalled the Shopify app
 *   analysis.completed    → Merchant ran an analysis in the Shopify app
 *   user.first_analysis   → Merchant ran their FIRST analysis (activation)
 *   ai.chat_used          → Merchant used the AI chat feature
 */

import type { Env } from '../types';
import { KV_PREFIX, TTL, CONTACT_STATUS, CONTACT_SOURCE, EVENT_TYPES } from '../constants';
import { hashEmail, todayKey } from '../lib/db';
import { upsertContact } from '../lib/crm';
import { enrollInSequences } from '../lib/email';
import { sendSlackNotification, sendDiscordNotification } from '../lib/notifications';

// ─── Event data interfaces ──────────────────────────────────────────────

export interface AppInstalledData {
  shop: string;              // e.g. 'store.myshopify.com'
  shopName?: string;         // store display name
  email?: string;            // merchant email (if known)
  plan?: string;             // Shopify plan (starter/growth/pro)
  _sourceNode?: string;      // originating node (shopify-app)
  _platformEventId?: string; // event bus correlation ID
  [key: string]: unknown;    // forward-compatible
}

export interface AppUninstalledData {
  shop: string;
  shopName?: string;
  email?: string;
  _sourceNode?: string;
  _platformEventId?: string;
  [key: string]: unknown;
}

export interface AnalysisCompletedData {
  shop: string;
  email?: string;            // merchant email (if resolved via identity)
  domain?: string;           // analyzed domain
  pagesAnalyzed?: number;
  score?: number;            // overall SEO score
  _sourceNode?: string;
  _platformEventId?: string;
  [key: string]: unknown;
}

export interface FirstAnalysisData extends AnalysisCompletedData {}

export interface AIChatUsedData {
  shop: string;
  email?: string;            // merchant email (if resolved via identity)
  prompt?: string;           // first 100 chars (truncated for privacy)
  _sourceNode?: string;
  _platformEventId?: string;
  [key: string]: unknown;
}

// ─── user.app_installed ─────────────────────────────────────────────────

/**
 * Handle Shopify app installation.
 *
 * Actions:
 * 1. Upsert CRM contact as trial/lead (shop domain as userId)
 * 2. Enroll in Shopify-specific onboarding email sequence
 * 3. Track daily install counter
 * 4. Send admin notification
 */
export async function handleAppInstalled(
  env: Env,
  data: AppInstalledData,
  timestamp: string
): Promise<void> {
  const userId = data.email || data.shop;
  if (!userId) {
    console.warn('[AppInstalled] No identifier — skipping');
    return;
  }
  const hashedId = await hashEmail(userId);
  console.log(`[AppInstalled] shop=${data.shop} user=${hashedId} plan=${data.plan ?? 'unknown'}`);

  // 1. Upsert CRM contact as trial
  await upsertContact(env, userId, {
    status: CONTACT_STATUS.TRIAL,
    source: CONTACT_SOURCE.DIRECT,
    metadata: JSON.stringify({
      shop: data.shop,
      shopName: data.shopName ?? null,
      plan: data.plan ?? null,
      installedAt: timestamp,
      sourceNode: 'shopify-app',
    }),
  });

  // 2. Enroll in onboarding sequence
  const enrolled = await enrollInSequences(env, userId, EVENT_TYPES.APP_INSTALLED, {
    shop: data.shop,
    plan: data.plan ?? 'starter',
  });
  console.log(`[AppInstalled] Enrolled in ${enrolled} email step(s)`);

  // 3. Track daily install counter
  const today = todayKey();
  const counterKey = `${KV_PREFIX.DAILY_EVENTS}installs:${today}`;
  const current = parseInt(await env.KV_MARKETING.get(counterKey) ?? '0', 10);
  await env.KV_MARKETING.put(counterKey, String(current + 1), {
    expirationTtl: TTL.DAYS_90,
  });

  // 4. Admin notification
  const message = `📱 **Shopify App Installed!**\nShop: ${data.shop}\nPlan: ${data.plan ?? 'unknown'}`;
  await Promise.allSettled([
    sendSlackNotification(env, message),
    sendDiscordNotification(env, message),
  ]);
}

// ─── user.app_uninstalled ───────────────────────────────────────────────

/**
 * Handle Shopify app uninstallation.
 *
 * Actions:
 * 1. Update CRM contact to churned
 * 2. Enroll in win-back sequence
 * 3. Track daily uninstall counter
 * 4. Send admin notification
 */
export async function handleAppUninstalled(
  env: Env,
  data: AppUninstalledData,
  timestamp: string
): Promise<void> {
  const userId = data.email || data.shop;
  if (!userId) {
    console.warn('[AppUninstalled] No identifier — skipping');
    return;
  }
  const hashedId = await hashEmail(userId);
  console.log(`[AppUninstalled] shop=${data.shop} user=${hashedId}`);

  // 1. Mark as churned in CRM
  await upsertContact(env, userId, {
    status: CONTACT_STATUS.CHURNED,
    metadata: JSON.stringify({
      shop: data.shop,
      uninstalledAt: timestamp,
      sourceNode: 'shopify-app',
    }),
  });

  // 2. Enroll in win-back sequence (same as user.churned)
  await enrollInSequences(env, userId, EVENT_TYPES.USER_CHURNED, {
    previousPlan: 'shopify',
    daysActive: 0,
  }).catch((e) => console.error('[AppUninstalled] Sequence error:', e));

  // 3. Track daily uninstall counter
  const today = todayKey();
  const counterKey = `${KV_PREFIX.DAILY_EVENTS}uninstalls:${today}`;
  const current = parseInt(await env.KV_MARKETING.get(counterKey) ?? '0', 10);
  await env.KV_MARKETING.put(counterKey, String(current + 1), {
    expirationTtl: TTL.DAYS_90,
  });

  // 4. Admin notification
  const message = `⚠️ **Shopify App Uninstalled**\nShop: ${data.shop}`;
  await Promise.allSettled([
    sendSlackNotification(env, message),
    sendDiscordNotification(env, message),
  ]);
}

// ─── analysis.completed ─────────────────────────────────────────────────

/**
 * Handle analysis completion — engagement signal.
 *
 * Actions:
 * 1. Increment daily analysis counter
 * 2. Log engagement (lightweight — no CRM write per analysis)
 */
export async function handleAnalysisCompleted(
  env: Env,
  data: AnalysisCompletedData,
  timestamp: string
): Promise<void> {
  console.log(
    `[AnalysisCompleted] shop=${data.shop} domain=${data.domain ?? '?'} ` +
    `pages=${data.pagesAnalyzed ?? '?'} score=${data.score ?? '?'}`
  );

  const today = todayKey();
  const counterKey = `${KV_PREFIX.DAILY_EVENTS}analyses:${today}`;
  const current = parseInt(await env.KV_MARKETING.get(counterKey) ?? '0', 10);
  await env.KV_MARKETING.put(counterKey, String(current + 1), {
    expirationTtl: TTL.DAYS_90,
  });
}

// ─── user.first_analysis ────────────────────────────────────────────────

/**
 * Handle first analysis — activation milestone.
 *
 * Actions:
 * 1. Update CRM contact metadata with activation timestamp
 * 2. Enroll in mid-onboarding email step
 * 3. Send admin notification (activation event)
 */
export async function handleFirstAnalysis(
  env: Env,
  data: FirstAnalysisData,
  timestamp: string
): Promise<void> {
  const userId = data.email || data.shop;
  if (!userId) {
    console.warn('[FirstAnalysis] No identifier — skipping');
    return;
  }
  const hashedId = await hashEmail(userId);
  console.log(
    `[FirstAnalysis] shop=${data.shop} user=${hashedId} ` +
    `pages=${data.pagesAnalyzed ?? '?'} score=${data.score ?? '?'}`
  );

  // 1. Update CRM with activation timestamp
  await upsertContact(env, userId, {
    metadata: JSON.stringify({
      firstAnalysisAt: timestamp,
      firstAnalysisScore: data.score ?? null,
      sourceNode: 'shopify-app',
    }),
  });

  // 2. Enroll in post-activation sequence
  await enrollInSequences(env, userId, EVENT_TYPES.FIRST_ANALYSIS, {
    shop: data.shop,
    score: String(data.score ?? 0),
    pagesAnalyzed: String(data.pagesAnalyzed ?? 0),
  }).catch((e) => console.error('[FirstAnalysis] Sequence error:', e));

  // 3. Admin notification
  const message = `🎉 **First Analysis Completed!**\nShop: ${data.shop}\nScore: ${data.score ?? '?'}`;
  await Promise.allSettled([
    sendSlackNotification(env, message),
    sendDiscordNotification(env, message),
  ]);
}

// ─── ai.chat_used ───────────────────────────────────────────────────────

/**
 * Handle AI chat usage — engagement signal.
 *
 * Actions:
 * 1. Increment daily AI chat counter
 */
export async function handleAIChatUsed(
  env: Env,
  data: AIChatUsedData,
  timestamp: string
): Promise<void> {
  console.log(`[AIChatUsed] shop=${data.shop}`);

  const today = todayKey();
  const counterKey = `${KV_PREFIX.DAILY_EVENTS}ai-chats:${today}`;
  const current = parseInt(await env.KV_MARKETING.get(counterKey) ?? '0', 10);
  await env.KV_MARKETING.put(counterKey, String(current + 1), {
    expirationTtl: TTL.DAYS_90,
  });
}
