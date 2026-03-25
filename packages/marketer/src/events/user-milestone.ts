/**
 * User Milestone Event Handler
 *
 * Triggered when: A user hits a usage milestone in visibility-analytics
 * (e.g., 100 keywords tracked, 1000 page views, 50 AI analyses).
 *
 * Responsibilities:
 * 1. Log the milestone in affiliate_notes for the user's affiliate (if any)
 * 2. Enroll in milestone celebration email sequence
 * 3. Update contact metadata with latest milestone
 * 4. Increment milestone counter in KV for admin dashboards
 */

import type { Env, UserMilestoneData } from '../types';
import { KV_PREFIX, TTL, EVENT_TYPES, NOTE_TYPE } from '../constants';
import { getContact, upsertContact } from '../lib/crm';
import { enrollInSequences } from '../lib/email.ts';
import { execute, now, todayKey, hashEmail } from '../lib/db';

export async function handleUserMilestone(
  env: Env,
  data: UserMilestoneData,
  timestamp: string
): Promise<void> {
  const { userId, milestoneType, milestoneValue } = data;
  const hashedUserId = await hashEmail(userId);

  console.log(
    `[UserMilestone] user=${hashedUserId} type=${milestoneType} value=${milestoneValue}`
  );

  // ── 1. Update contact metadata with milestone ──
  await upsertContact(env, userId, {
    metadata: JSON.stringify({
      lastMilestone: milestoneType,
      milestoneValue,
      milestoneAt: timestamp,
    }),
  });

  // ── 2. Enroll in milestone celebration sequence ──
  await enrollInSequences(env, userId, EVENT_TYPES.USER_MILESTONE, {
    milestoneType,
    milestoneValue,
  }).catch((err: unknown) => {
    console.error('[UserMilestone] Sequence enrollment error:', err);
  });

  // ── 3. Increment daily milestone counter ──
  const today = todayKey();
  const counterKey = `${KV_PREFIX.DAILY_EVENTS}milestone:${today}`;
  const current = parseInt(await env.KV_MARKETING.get(counterKey) ?? '0', 10);
  await env.KV_MARKETING.put(counterKey, String(current + 1), {
    expirationTtl: TTL.DAYS_7,
  });

  // ── 4. Log milestone note if user has an affiliate ──
  // Look up the user's affiliate attribution
  const contact = await getContact(env, userId);
  if (contact?.affiliate_code) {
    await execute(
      env.DB,
      `INSERT INTO affiliate_notes (affiliate_code, note_type, content, created_at)
       VALUES (?, ?, ?, ?)`,
      [
        contact.affiliate_code,
        NOTE_TYPE.MILESTONE,
        `Referred user hit milestone: ${milestoneType} = ${milestoneValue}`,
        now(),
      ]
    ).catch((err: unknown) => {
      console.error('[UserMilestone] Affiliate note error:', err);
    });
  }

  console.log(`[UserMilestone] Completed processing for ${hashedUserId}`);
}
