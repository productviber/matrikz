import type { ContactChannelIdentityRow, Env } from '../../types';
import { SKRIP_CHANNEL, SKRIP_CONFIG, SKRIP_OUTBOX_STATUS } from '../../constants';
import { execute, now, query } from '../db';
import { buildSkripIdempotencyKey, resolveSkripExecutionDecision } from './router';

const SKRIP_CHANNELS = [
  SKRIP_CHANNEL.PUSH,
  SKRIP_CHANNEL.SMS,
  SKRIP_CHANNEL.WHATSAPP,
  SKRIP_CHANNEL.TELEGRAM,
] as const;

export interface SkripOutboxEnqueueInput {
  tenantId?: string;
  campaignId: string;
  journeyId?: string | null;
  stepId: string;
  contactId: string;
  domain?: string | null;
  context?: Record<string, unknown>;
  scheduleAt?: number;
  /** Originating agent action ID for lineage tracing (D3 linkage). */
  agentActionId?: string | null;
}

export interface SkripOutboxEnqueueResult {
  channel: string;
  status: string;
  idempotencyKey: string;
  dryRun: boolean;
  authority: string;
  rolloutState: string;
}

export async function getEligibleSkripIdentities(
  env: Env,
  tenantId: string,
  externalContactId: string,
): Promise<ContactChannelIdentityRow[]> {
  return query<ContactChannelIdentityRow>(
    env.DB,
    `SELECT *
       FROM contact_channel_identities
      WHERE tenant_id = ?
        AND external_contact_id = ?
        AND channel IN ('push', 'sms', 'whatsapp', 'telegram')
        AND consent_state IN ('opted_in', 'subscribed', 'granted')
        AND suppression_state IN ('clear', 'allowed', 'unsuppressed')
        AND availability_state IN ('available', 'reachable')
        AND registration_state IN ('registered', 'active')
      ORDER BY CASE channel
        WHEN 'push' THEN 1
        WHEN 'sms' THEN 2
        WHEN 'whatsapp' THEN 3
        WHEN 'telegram' THEN 4
        ELSE 99 END ASC`,
    [tenantId, externalContactId],
  );
}

export async function enqueueEligibleSkripChannels(
  env: Env,
  input: SkripOutboxEnqueueInput,
): Promise<SkripOutboxEnqueueResult[]> {
  const tenantId = input.tenantId ?? SKRIP_CONFIG.DEFAULT_TENANT_ID;
  const scheduleAt = input.scheduleAt ?? now();
  const scheduleSlot = new Date(scheduleAt * 1000).toISOString().slice(0, 16) + 'Z';
  const identities = await getEligibleSkripIdentities(env, tenantId, input.contactId);

  const results: SkripOutboxEnqueueResult[] = [];
  for (const identity of identities) {
    if (!(SKRIP_CHANNELS as readonly string[]).includes(identity.channel)) {
      continue;
    }

    const decision = await resolveSkripExecutionDecision(env, tenantId, input.campaignId, identity.channel);
    if (decision.authority !== 'skrip' || !decision.flags.effectiveEnabled) {
      continue;
    }

    const idempotencyKey = buildSkripIdempotencyKey({
      tenantId,
      campaignId: input.campaignId,
      stepId: input.stepId,
      contactId: input.contactId,
      channel: identity.channel,
      scheduleSlot,
    });

    const status = decision.dryRun ? SKRIP_OUTBOX_STATUS.DRY_RUN : SKRIP_OUTBOX_STATUS.PENDING;
    const epoch = now();
    await execute(
      env.DB,
      `INSERT OR IGNORE INTO channel_execution_outbox
        (tenant_id, campaign_id, journey_id, step_id, contact_id, channel, schedule_slot, idempotency_key, payload_json, status, attempt_count, next_attempt_at, last_error_code, last_error_message, correlation_id, agent_action_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?, ?, ?)`,
      [
        tenantId,
        input.campaignId,
        input.journeyId ?? null,
        input.stepId,
        input.contactId,
        identity.channel,
        scheduleSlot,
        idempotencyKey,
        JSON.stringify({
          tenantId,
          campaignId: input.campaignId,
          journeyId: input.journeyId ?? null,
          stepId: input.stepId,
          contact: {
            externalContactId: input.contactId,
            canonicalId: identity.canonical_id,
          },
          channel: identity.channel,
          schedule: {
            mode: 'scheduled',
            scheduledFor: new Date(scheduleAt * 1000).toISOString(),
            scheduleSlot,
          },
          metadata: {
            domain: input.domain ?? null,
            dryRun: decision.dryRun,
          },
          context: input.context ?? {},
        }),
        status,
        scheduleAt,
        idempotencyKey,
        input.agentActionId ?? null,
        epoch,
        epoch,
      ],
    );

    results.push({
      channel: identity.channel,
      status,
      idempotencyKey,
      dryRun: decision.dryRun,
      authority: decision.authority,
      rolloutState: decision.rolloutState,
    });
  }

  return results;
}
