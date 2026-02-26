/**
 * User Signup Event Handler
 *
 * Triggered when: A new user creates an account in visibility-analytics
 * (via any authentication provider: Google, GitHub, email/password).
 *
 * Responsibilities:
 * 1. Upsert contact as "lead" in the marketing CRM
 * 2. Set contact source (affiliate | organic) based on referral attribution
 * 3. Enroll contact in the welcome email sequence (trigger: user.signup)
 * 4. Increment daily signup counter in KV for admin dashboards
 * 5. Store signup context in KV for downstream event correlation
 * 6. Log an audit note to affiliate_notes if signup was referred
 */

import type { Env, UserSignupData } from '../types';
import { KV_PREFIX, TTL, CONTACT_STATUS, CONTACT_SOURCE, EVENT_TYPES } from '../constants';
import { hashEmail, formatCents } from '../lib/db';
import { enrollInSequences } from '../lib/email';
import { upsertContact } from '../lib/crm';
import { execute, now } from '../lib/db';

export async function handleUserSignup(
  env: Env,
  data: UserSignupData,
  timestamp: string
): Promise<void> {
  const { userId, provider, referrer, affiliateCode } = data;

  // Hash the email/userId once and reuse for privacy-safe logging
  const hashedUserId = await hashEmail(userId);

  console.log(
    `[UserSignup] user=${hashedUserId} provider=${provider} ` +
    `referrer=${referrer ?? 'none'} affiliateCode=${affiliateCode ?? 'none'}`
  );

  // ── 1. Determine contact source ──
  const source = affiliateCode ? CONTACT_SOURCE.AFFILIATE : CONTACT_SOURCE.ORGANIC;

  // ── 2. Upsert contact as "lead" in CRM ──
  // On INSERT: status=lead, source set appropriately, affiliate_code recorded.
  // On UPDATE: only sets affiliate_code if a new one is provided (referral attribution).
  await upsertContact(env, userId, {
    status: CONTACT_STATUS.LEAD,
    source,
    affiliate_code: affiliateCode ?? undefined,
    metadata: JSON.stringify({
      signupProvider: provider,
      referrer: referrer ?? null,
      signedUpAt: timestamp,
    }),
  });

  // ── 3. Enroll in welcome email sequence ──
  const enrolledSteps = await enrollInSequences(
    env,
    userId,
    EVENT_TYPES.USER_SIGNUP,
    {
      provider,
      referrer: referrer ?? '',
      affiliateCode: affiliateCode ?? '',
    }
  );
  console.log(`[UserSignup] Enrolled ${hashedUserId} in ${enrolledSteps} welcome email step(s)`);

  // ── 4. Increment daily signup counter in KV ──
  const todayKey = new Date().toISOString().slice(0, 10);
  const signupCounterKey = `daily-signups:${todayKey}`;
  const currentCount = parseInt(
    (await env.KV_MARKETING.get(signupCounterKey)) ?? '0',
    10
  );
  await env.KV_MARKETING.put(signupCounterKey, String(currentCount + 1), {
    expirationTtl: TTL.DAYS_90,
  });

  // ── 5. Store signup context in KV for downstream correlation ──
  //    Useful when user.converted fires later — we can look up how they arrived.
  const signupContextKey = `${KV_PREFIX.USER_CONVERSION}signup:${userId}`;
  await env.KV_MARKETING.put(
    signupContextKey,
    JSON.stringify({
      provider,
      referrer: referrer ?? null,
      affiliateCode: affiliateCode ?? null,
      signedUpAt: timestamp,
      source,
    }),
    { expirationTtl: TTL.YEAR_1 }
  );

  // ── 6. Audit note if signup was via affiliate referral ──
  if (affiliateCode) {
    try {
      await execute(
        env.DB,
        `INSERT INTO affiliate_notes (affiliate_code, note_type, content, created_at)
         VALUES (?, ?, ?, ?)`,
        [
          affiliateCode,
          'general',
          `Referred signup: user=${hashedUserId} provider=${provider} at ${timestamp}`,
          now(),
        ]
      );
    } catch (err) {
      // Non-fatal — log and continue
      console.error(`[UserSignup] Failed to log affiliate note for ${affiliateCode}:`, err);
    }
  }

  console.log(`[UserSignup] Completed processing for ${hashedUserId}`);
}
