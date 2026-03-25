/**
 * Domain Reputation Monitor — tracks sender domain health over time.
 *
 * Aggregates daily deliverability signals (bounce rate, complaint rate,
 * open rate, delivery rate) and stores rolling 30-day snapshots in KV.
 * Used by the daily cron to detect reputation degradation early.
 */

import type { Env } from '../types';
import { KV_PREFIX, TTL } from '../constants';
import { query, queryOne, now } from './db';

const REPUTATION_KV_PREFIX = 'reputation:daily:';
const REPUTATION_WINDOW_DAYS = 30;

interface DailyReputationSnapshot {
  date: string;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  opened: number;
  clicked: number;
  replied: number;
  bounceRate: number;
  complaintRate: number;
  openRate: number;
  healthScore: number; // 0-100 composite score
}

/**
 * Compute and store today's reputation snapshot.
 * Called from the scheduled handler (daily or per-cron).
 */
export async function captureReputationSnapshot(env: Env): Promise<DailyReputationSnapshot | null> {
  const todayStart = now() - (now() % 86400); // midnight UTC
  const todayEnd = todayStart + 86400;
  const dateKey = new Date(todayStart * 1000).toISOString().slice(0, 10);

  // Check if already captured today
  const existing = await env.KV_MARKETING.get(`${REPUTATION_KV_PREFIX}${dateKey}`);
  if (existing) return JSON.parse(existing) as DailyReputationSnapshot;

  // Aggregate today's send metrics from DB
  const stats = await queryOne<{
    sent: number;
    delivered: number;
    bounced: number;
    opened: number;
    clicked: number;
    replied: number;
  }>(env.DB,
    `SELECT
       COUNT(CASE WHEN status = 'sent' THEN 1 END) as sent,
       COUNT(CASE WHEN status = 'sent' AND error IS NULL THEN 1 END) as delivered,
       COUNT(CASE WHEN error LIKE '%bounce%' OR status = 'failed' THEN 1 END) as bounced,
       0 as opened, 0 as clicked, 0 as replied
     FROM email_sends
     WHERE scheduled_at >= ? AND scheduled_at < ?`,
    [todayStart, todayEnd],
  );

  // Fetch deliverability counters from KV (more accurate for opens/clicks)
  const deliverabilityJson = await env.KV_MARKETING.get(`${KV_PREFIX.OUTBOUND_DELIVERABILITY}${dateKey}`);
  const deliverability = deliverabilityJson ? JSON.parse(deliverabilityJson) as Record<string, number> : {};

  const sent = stats?.sent ?? 0;
  const delivered = stats?.delivered ?? 0;
  const bounced = stats?.bounced ?? 0;
  const complained = deliverability.complained ?? 0;
  const opened = deliverability.opened ?? 0;
  const clicked = deliverability.clicked ?? 0;
  const replied = deliverability.replied ?? 0;

  const bounceRate = sent > 0 ? bounced / sent : 0;
  const complaintRate = sent > 0 ? complained / sent : 0;
  const openRate = sent > 0 ? opened / sent : 0;

  // Composite health score: 100 = perfect, penalized by bounces/complaints
  const healthScore = Math.max(0, Math.min(100, Math.round(
    100
    - (bounceRate * 500)       // -50 at 10% bounce rate
    - (complaintRate * 10000)  // -100 at 1% complaint rate
    + (openRate * 30)          // +30 at 100% open rate (bonus)
  )));

  const snapshot: DailyReputationSnapshot = {
    date: dateKey,
    sent, delivered, bounced, complained,
    opened, clicked, replied,
    bounceRate: Math.round(bounceRate * 10000) / 100,
    complaintRate: Math.round(complaintRate * 10000) / 100,
    openRate: Math.round(openRate * 10000) / 100,
    healthScore,
  };

  await env.KV_MARKETING.put(
    `${REPUTATION_KV_PREFIX}${dateKey}`,
    JSON.stringify(snapshot),
    { expirationTtl: REPUTATION_WINDOW_DAYS * 86400 },
  );

  return snapshot;
}

/**
 * Load the last N days of reputation snapshots (rolling window).
 */
export async function getReputationTrend(
  kv: { get(key: string): Promise<string | null>; list(opts: { prefix: string }): Promise<{ keys: Array<{ name: string }> }> },
  days: number = REPUTATION_WINDOW_DAYS,
): Promise<DailyReputationSnapshot[]> {
  const listResult = await kv.list({ prefix: REPUTATION_KV_PREFIX });
  const keys = listResult.keys
    .map(k => k.name)
    .sort()
    .slice(-days);

  const snapshots = await Promise.all(
    keys.map(async (key) => {
      const raw = await kv.get(key);
      return raw ? JSON.parse(raw) as DailyReputationSnapshot : null;
    }),
  );

  return snapshots.filter((s): s is DailyReputationSnapshot => s !== null);
}
