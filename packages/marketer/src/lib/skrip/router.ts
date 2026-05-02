import type { Env, ChannelAuthorityRow } from '../../types';
import { SKRIP_AUTHORITY, SKRIP_ROLLOUT_STATE } from '../../constants';
import { queryOne } from '../db';
import { getSkripFlagSnapshot, type SkripFlagSnapshot } from './flags';

export interface SkripExecutionDecision {
  authority: string;
  rolloutState: string;
  featureFlagKey: string | null;
  flags: SkripFlagSnapshot;
  useSkrip: boolean;
  dryRun: boolean;
}

export function buildSkripIdempotencyKey(input: {
  tenantId: string;
  campaignId: string;
  stepId: string;
  contactId: string;
  channel: string;
  scheduleSlot: string;
}): string {
  return [
    input.tenantId,
    input.campaignId,
    input.stepId,
    input.contactId,
    input.channel,
    input.scheduleSlot,
  ].join(':');
}

async function findAuthorityRow(
  env: Env,
  tenantId: string,
  campaignId: string | null,
  channel: string,
): Promise<ChannelAuthorityRow | null> {
  return queryOne<ChannelAuthorityRow>(
    env.DB,
    `SELECT *
       FROM channel_authorities
      WHERE tenant_id = ?
        AND channel = ?
        AND (campaign_id = ? OR campaign_id IS NULL)
      ORDER BY CASE WHEN campaign_id = ? THEN 0 ELSE 1 END ASC
      LIMIT 1`,
    [tenantId, channel, campaignId, campaignId],
  );
}

export async function resolveSkripExecutionDecision(
  env: Env,
  tenantId: string,
  campaignId: string | null,
  channel: string,
): Promise<SkripExecutionDecision> {
  const [authorityRow, flags] = await Promise.all([
    findAuthorityRow(env, tenantId, campaignId, channel),
    getSkripFlagSnapshot(env, tenantId, campaignId, channel),
  ]);

  const authority = authorityRow?.authority ?? SKRIP_AUTHORITY.VISIBILITY_MARKETING;
  const rolloutState = authorityRow?.rollout_state ?? SKRIP_ROLLOUT_STATE.DISABLED;
  const dryRun = rolloutState === SKRIP_ROLLOUT_STATE.DRY_RUN;
  const useSkrip =
    authority === SKRIP_AUTHORITY.SKRIP &&
    flags.effectiveEnabled &&
    rolloutState !== SKRIP_ROLLOUT_STATE.DISABLED &&
    rolloutState !== SKRIP_ROLLOUT_STATE.ROLLBACK;

  return {
    authority,
    rolloutState,
    featureFlagKey: authorityRow?.feature_flag_key ?? null,
    flags,
    useSkrip,
    dryRun,
  };
}
