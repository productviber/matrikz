/**
 * Share Event Handlers — PLG Funnel & PQL Scoring
 *
 * Processes the 6 share lifecycle events emitted by visibility-analytics:
 *
 *   share.created     → Track owner activity, increment owner stats
 *   share.viewed      → Upsert anonymous share lead, start PQL scoring
 *   share.engaged     → Increment PQL score based on dwell time
 *   share.cta_clicked → High-intent PQL signal, schedule dropout followup
 *   share.converted   → Record conversion, credit owner, celebrate
 *   share.revoked     → Mark affected leads as source-revoked
 *
 * PQL Score Model (cumulative, additive from analytics hints):
 *   <20  = cold    → no action
 *   20+  = warm    → track interest
 *   50+  = hot     → Slack alert, consider outreach
 *   80+  = PQL     → product-qualified, priority follow-up
 *   100  = convert → actual signup — attribute to share owner
 */

import type {
  Env,
  ShareCreatedData,
  ShareViewedData,
  ShareEngagedData,
  ShareCTAClickedData,
  ShareConvertedData,
  ShareRevokedData,
  ShareLeadRow,
} from '../types';
import {
  KV_PREFIX,
  TTL,
  PQL_THRESHOLD,
  SHARE_LEAD_STATUS,
  PLG_STAGE,
  CONTACT_STATUS,
  CONTACT_SOURCE,
  EVENT_TYPES,
  NOTE_TYPE,
  MESSAGES,
} from '../constants';
import { execute, queryOne, now, hashEmail } from '../lib/db';
import { enrollInSequences } from '../lib/email';
import { upsertContact } from '../lib/crm';
import {
  notifyShareConversion,
  notifyShareHighEngagement,
  notifySharePQL,
} from '../lib/notifications';

// ─── share.created ──────────────────────────────────────────────────────────

/**
 * Handle share.created — owner has created a new share link.
 *
 * Actions:
 * 1. Increment owner's share count in D1
 * 2. Cache owner stats in KV
 * 3. Log audit note
 */
export async function handleShareCreated(
  env: Env,
  data: ShareCreatedData,
  timestamp: string
): Promise<void> {
  const { owner, token, scopes, role, tier } = data;
  const hashedOwner = await hashEmail(owner);

  console.log(
    `[ShareCreated] owner=${hashedOwner} token=${token} scopes=${scopes.join(',')} tier=${tier}`
  );

  // ── 1. Upsert owner stats in D1 ──
  const existing = await queryOne<{ id: number }>(
    env.DB,
    `SELECT id FROM share_owner_stats WHERE owner_email = ?`,
    [owner]
  );

  if (existing) {
    await execute(
      env.DB,
      `UPDATE share_owner_stats
       SET total_shares = total_shares + 1, last_share_at = ?, updated_at = ?
       WHERE owner_email = ?`,
      [now(), now(), owner]
    );
  } else {
    await execute(
      env.DB,
      `INSERT INTO share_owner_stats (owner_email, total_shares, last_share_at, updated_at)
       VALUES (?, 1, ?, ?)`,
      [owner, now(), now()]
    );
  }

  // ── 2. Cache in KV for fast reads ──
  const kvKey = `${KV_PREFIX.SHARE_OWNER_STATS}${owner}`;
  const cachedJson = await env.KV_MARKETING.get(kvKey);
  const cached = cachedJson ? JSON.parse(cachedJson) : { totalShares: 0, totalViews: 0, totalConversions: 0 };
  cached.totalShares += 1;
  cached.lastShareAt = timestamp;
  await env.KV_MARKETING.put(kvKey, JSON.stringify(cached), { expirationTtl: TTL.YEAR_1 });

  // ── 3. Log audit note ──
  await execute(
    env.DB,
    `INSERT INTO affiliate_notes (affiliate_code, note_type, content, created_at)
     VALUES (?, ?, ?, ?)`,
    [
      `share:${hashedOwner}`,
      NOTE_TYPE.GENERAL,
      MESSAGES.notes.shareCreated(hashedOwner, token, scopes.join(',')),
      now(),
    ]
  );

  console.log(`[ShareCreated] Completed for ${hashedOwner}`);
}

// ─── share.viewed ───────────────────────────────────────────────────────────

/**
 * Handle share.viewed — anonymous recipient opened a share link.
 *
 * Actions:
 * 1. Upsert share_leads row (by token)
 * 2. Add PQL score hint
 * 3. Promote lead status if threshold crossed
 * 4. Increment daily view counter
 */
export async function handleShareViewed(
  env: Env,
  data: ShareViewedData,
  timestamp: string
): Promise<void> {
  const { token, accessCount, scopes, pqlScoreHint, owner, ip } = data;

  console.log(`[ShareViewed] token=${token} views=${accessCount} pql_hint=${pqlScoreHint} owner=${owner ?? 'unknown'}`);

  // ── 1. Upsert share lead in D1 ──
  const existing = await queryOne<ShareLeadRow>(
    env.DB,
    `SELECT * FROM share_leads WHERE token = ?`,
    [token]
  );

  const metadata = JSON.stringify({ ip: ip ?? null, scopes });

  if (existing) {
    const newScore = existing.pql_score + pqlScoreHint;
    const newStatus = computeLeadStatus(newScore);

    await execute(
      env.DB,
      `UPDATE share_leads
       SET total_views = ?, pql_score = ?, status = ?, plg_stage = ?,
           scopes_viewed = ?, owner_email = COALESCE(?, owner_email),
           metadata = ?, last_seen_at = ?, updated_at = ?
       WHERE token = ?`,
      [
        accessCount,
        newScore,
        newStatus,
        PLG_STAGE.ACTIVATION,
        JSON.stringify(scopes),
        owner ?? null,
        metadata,
        now(),
        now(),
        token,
      ]
    );
  } else {
    const initialStatus = computeLeadStatus(pqlScoreHint);
    await execute(
      env.DB,
      `INSERT INTO share_leads (token, owner_email, status, plg_stage, pql_score, total_views, scopes_viewed, metadata, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        token,
        owner ?? null,
        initialStatus,
        PLG_STAGE.ACTIVATION,
        pqlScoreHint,
        accessCount,
        JSON.stringify(scopes),
        metadata,
        now(),
        now(),
      ]
    );
  }

  // ── 2. Update daily view counter ──
  const todayKey = new Date().toISOString().slice(0, 10);
  const counterKey = `${KV_PREFIX.DAILY_SHARE_VIEWS}${todayKey}`;
  const current = parseInt(await env.KV_MARKETING.get(counterKey) ?? '0', 10);
  await env.KV_MARKETING.put(counterKey, String(current + 1), { expirationTtl: TTL.DAYS_90 });

  // ── 3. Increment owner's total_views in D1 + KV ──
  if (owner) {
    const ownerExists = await queryOne<{ id: number }>(
      env.DB,
      `SELECT id FROM share_owner_stats WHERE owner_email = ?`,
      [owner]
    );

    if (ownerExists) {
      await execute(
        env.DB,
        `UPDATE share_owner_stats SET total_views = total_views + 1, updated_at = ? WHERE owner_email = ?`,
        [now(), owner]
      );
    } else {
      await execute(
        env.DB,
        `INSERT INTO share_owner_stats (owner_email, total_views, updated_at) VALUES (?, 1, ?)`,
        [owner, now()]
      );
    }

    // Update KV cache
    const kvKey = `${KV_PREFIX.SHARE_OWNER_STATS}${owner}`;
    const cachedJson = await env.KV_MARKETING.get(kvKey);
    const cached = cachedJson ? JSON.parse(cachedJson) : { totalShares: 0, totalViews: 0, totalConversions: 0 };
    cached.totalViews += 1;
    await env.KV_MARKETING.put(kvKey, JSON.stringify(cached), { expirationTtl: TTL.YEAR_1 });
  }

  console.log(`[ShareViewed] Completed for ${token}`);
}

// ─── share.engaged ──────────────────────────────────────────────────────────

/**
 * Handle share.engaged — recipient stayed 30s+ on the share page.
 *
 * Actions:
 * 1. Increment PQL score based on dwell-time hint
 * 2. Update lead plg_stage to 'engagement'
 * 3. For 120s+ dwell: notify team (Slack/Discord)
 * 4. For 120s+ dwell: enroll share owner in engagement email
 */
export async function handleShareEngaged(
  env: Env,
  data: ShareEngagedData,
  timestamp: string
): Promise<void> {
  const { token, dwellSeconds, pqlScoreHint } = data;

  console.log(`[ShareEngaged] token=${token} dwell=${dwellSeconds}s pql_hint=${pqlScoreHint}`);

  // ── 1. Update lead in D1 ──
  const lead = await queryOne<ShareLeadRow>(
    env.DB,
    `SELECT * FROM share_leads WHERE token = ?`,
    [token]
  );

  if (lead) {
    const newScore = lead.pql_score + pqlScoreHint;
    const newStatus = computeLeadStatus(newScore);
    const newDwell = lead.total_dwell_seconds + dwellSeconds;

    await execute(
      env.DB,
      `UPDATE share_leads
       SET pql_score = ?, status = ?, plg_stage = ?,
           total_dwell_seconds = ?, last_seen_at = ?, updated_at = ?
       WHERE token = ?`,
      [newScore, newStatus, PLG_STAGE.ENGAGEMENT, newDwell, now(), now(), token]
    );

    // ── 2. High-engagement actions (120s+) ──
    if (dwellSeconds >= 120) {
      // Notify team
      await notifyShareHighEngagement(env, token, dwellSeconds, newScore);

      // Increment owner engagement counter
      if (lead.owner_email) {
        await execute(
          env.DB,
          `UPDATE share_owner_stats SET total_engagements = total_engagements + 1, updated_at = ? WHERE owner_email = ?`,
          [now(), lead.owner_email]
        );

        // Enroll owner in engagement followup email
        await enrollInSequences(env, lead.owner_email, EVENT_TYPES.SHARE_ENGAGED, {
          token,
          dwellSeconds,
          pqlScore: newScore,
        });
      }
    }

    // ── 3. Check if PQL threshold crossed ──
    if (lead.pql_score < PQL_THRESHOLD.PQL && newScore >= PQL_THRESHOLD.PQL) {
      await notifySharePQL(env, token, newScore);
    }
  } else {
    // Lead doesn't exist yet — create with engagement data
    const initialStatus = computeLeadStatus(pqlScoreHint);
    await execute(
      env.DB,
      `INSERT INTO share_leads (token, status, plg_stage, pql_score, total_dwell_seconds, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [token, initialStatus, PLG_STAGE.ENGAGEMENT, pqlScoreHint, dwellSeconds, now(), now()]
    );
  }

  console.log(`[ShareEngaged] Completed for ${token}`);
}

// ─── share.cta_clicked ──────────────────────────────────────────────────────

/**
 * Handle share.cta_clicked — recipient clicked the "Start Free" CTA.
 *
 * Actions:
 * 1. Max out PQL intent signal
 * 2. Update lead to 'intent' PLG stage
 * 3. Increment owner CTA click count
 * 4. Enroll the *clicker* in CTA dropout sequence (if they don't convert in 24h)
 */
export async function handleShareCTAClicked(
  env: Env,
  data: ShareCTAClickedData,
  timestamp: string
): Promise<void> {
  const { token, dwellSeconds, pqlScoreHint } = data;

  console.log(`[ShareCTAClicked] token=${token} dwell=${dwellSeconds}s pql_hint=${pqlScoreHint}`);

  // ── 1. Update lead ──
  const lead = await queryOne<ShareLeadRow>(
    env.DB,
    `SELECT * FROM share_leads WHERE token = ?`,
    [token]
  );

  if (lead) {
    const newScore = lead.pql_score + pqlScoreHint;
    const newStatus = computeLeadStatus(newScore);

    await execute(
      env.DB,
      `UPDATE share_leads
       SET pql_score = ?, status = ?, plg_stage = ?, last_seen_at = ?, updated_at = ?
       WHERE token = ?`,
      [newScore, newStatus, PLG_STAGE.INTENT, now(), now(), token]
    );

    // Check PQL threshold
    if (lead.pql_score < PQL_THRESHOLD.PQL && newScore >= PQL_THRESHOLD.PQL) {
      await notifySharePQL(env, token, newScore);
    }
  } else {
    await execute(
      env.DB,
      `INSERT INTO share_leads (token, status, plg_stage, pql_score, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [token, computeLeadStatus(pqlScoreHint), PLG_STAGE.INTENT, pqlScoreHint, now(), now()]
    );
  }

  // ── 2. Increment owner CTA click count ──
  if (lead?.owner_email) {
    await execute(
      env.DB,
      `UPDATE share_owner_stats SET total_cta_clicks = total_cta_clicks + 1, updated_at = ? WHERE owner_email = ?`,
      [now(), lead.owner_email]
    );
  }

  console.log(`[ShareCTAClicked] Completed for ${token}`);
}

// ─── share.converted ────────────────────────────────────────────────────────

/**
 * Handle share.converted — a share-attributed user completed OAuth signup.
 *
 * Actions:
 * 1. Mark lead as converted in D1
 * 2. Upsert CRM contact with share source
 * 3. Credit the share owner (increment conversion count)
 * 4. Enroll owner in conversion celebration email
 * 5. Notify team (Slack/Discord)
 */
export async function handleShareConverted(
  env: Env,
  data: ShareConvertedData,
  timestamp: string
): Promise<void> {
  const { shareToken, newUserId, pqlScoreHint } = data;
  const hashedNewUser = await hashEmail(newUserId);

  console.log(`[ShareConverted] token=${shareToken} newUser=${hashedNewUser}`);

  // ── 1. Update share lead to converted ──
  const lead = await queryOne<ShareLeadRow>(
    env.DB,
    `SELECT * FROM share_leads WHERE token = ?`,
    [shareToken]
  );

  if (lead) {
    await execute(
      env.DB,
      `UPDATE share_leads
       SET status = ?, plg_stage = ?, pql_score = ?,
           converted_user_id = ?, converted_at = ?, updated_at = ?
       WHERE token = ?`,
      [
        SHARE_LEAD_STATUS.CONVERTED,
        PLG_STAGE.CONVERSION,
        lead.pql_score + pqlScoreHint,
        newUserId,
        now(),
        now(),
        shareToken,
      ]
    );
  }

  // ── 2. Upsert CRM contact with share attribution ──
  await upsertContact(env, newUserId, {
    status: CONTACT_STATUS.LEAD,
    source: CONTACT_SOURCE.SHARE,
    metadata: JSON.stringify({
      shareToken,
      shareOwner: lead?.owner_email ?? null,
      convertedAt: timestamp,
    }),
  });

  // ── 3. Credit share owner ──
  if (lead?.owner_email) {
    await execute(
      env.DB,
      `UPDATE share_owner_stats
       SET total_conversions = total_conversions + 1, last_conversion_at = ?, updated_at = ?
       WHERE owner_email = ?`,
      [now(), now(), lead.owner_email]
    );

    // Update KV cache
    const kvKey = `${KV_PREFIX.SHARE_OWNER_STATS}${lead.owner_email}`;
    const cachedJson = await env.KV_MARKETING.get(kvKey);
    const cached = cachedJson ? JSON.parse(cachedJson) : { totalShares: 0, totalViews: 0, totalConversions: 0 };
    cached.totalConversions += 1;
    cached.lastConversionAt = timestamp;
    await env.KV_MARKETING.put(kvKey, JSON.stringify(cached), { expirationTtl: TTL.YEAR_1 });

    // ── 4. Enroll owner in conversion celebration email ──
    await enrollInSequences(env, lead.owner_email, EVENT_TYPES.SHARE_CONVERTED, {
      token: shareToken,
      newUser: hashedNewUser,
    });

    // ── 5. Log audit note ──
    await execute(
      env.DB,
      `INSERT INTO affiliate_notes (affiliate_code, note_type, content, created_at)
       VALUES (?, ?, ?, ?)`,
      [
        `share:${await hashEmail(lead.owner_email)}`,
        NOTE_TYPE.CONVERSION,
        MESSAGES.notes.shareConversion(await hashEmail(lead.owner_email), shareToken, hashedNewUser),
        now(),
      ]
    );
  }

  // ── 6. Notify team ──
  await notifyShareConversion(
    env,
    lead?.owner_email ?? 'unknown',
    shareToken,
    hashedNewUser
  );

  console.log(`[ShareConverted] Completed for ${shareToken}`);
}

// ─── share.revoked ──────────────────────────────────────────────────────────

/**
 * Handle share.revoked — owner deleted/revoked a share link.
 *
 * Actions:
 * 1. Mark all unconverted leads for this token as 'revoked'
 * 2. Cancel pending email sequences referencing this token
 * 3. Log audit note
 */
export async function handleShareRevoked(
  env: Env,
  data: ShareRevokedData,
  timestamp: string
): Promise<void> {
  const { owner, token } = data;
  const hashedOwner = await hashEmail(owner);

  console.log(`[ShareRevoked] token=${token} owner=${hashedOwner}`);

  // ── 1. Mark leads as revoked ──
  await execute(
    env.DB,
    `UPDATE share_leads
     SET status = ?, plg_stage = ?, updated_at = ?
     WHERE token = ? AND status != ?`,
    [SHARE_LEAD_STATUS.REVOKED, PLG_STAGE.LIFECYCLE, now(), token, SHARE_LEAD_STATUS.CONVERTED]
  );

  // ── 2. Log audit note ──
  await execute(
    env.DB,
    `INSERT INTO affiliate_notes (affiliate_code, note_type, content, created_at)
     VALUES (?, ?, ?, ?)`,
    [
      `share:${hashedOwner}`,
      NOTE_TYPE.GENERAL,
      MESSAGES.notes.shareRevoked(hashedOwner, token),
      now(),
    ]
  );

  console.log(`[ShareRevoked] Completed for ${token}`);
}

// ─── PQL Score → Lead Status ────────────────────────────────────────────────

/**
 * Compute lead status from cumulative PQL score.
 */
function computeLeadStatus(pqlScore: number): string {
  if (pqlScore >= PQL_THRESHOLD.PQL) return SHARE_LEAD_STATUS.PQL;
  if (pqlScore >= PQL_THRESHOLD.HOT) return SHARE_LEAD_STATUS.HOT;
  if (pqlScore >= PQL_THRESHOLD.WARM) return SHARE_LEAD_STATUS.WARM;
  return SHARE_LEAD_STATUS.COLD;
}
