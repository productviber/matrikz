import type { Env } from '../types';
import { SKRIP_OUTBOX_STATUS } from '../constants';
import { execute, now } from '../lib/db';
import { badRequest, json, unauthorized } from '../lib/response';
import {
  markDispatchAccepted,
  markDispatchRejected,
  saveDispatchCorrelation,
  validateDispatchIngressPayload,
} from '../lib/growth/closedLoop';

function scheduleSlot(epoch: number): string {
  return new Date(epoch * 1000).toISOString().slice(0, 16) + 'Z';
}

export async function handleDispatchIngress(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get('x-internal-secret') ?? '';
  const secretValid = Boolean(
    secret && (
      (env.INTERNAL_SECRET && secret === env.INTERNAL_SECRET)
      || (env.INTERNAL_SECRET_ROLLOVER && secret === env.INTERNAL_SECRET_ROLLOVER)
    ),
  );

  if (!secretValid) {
    await markDispatchRejected(env);
    return unauthorized('Invalid internal secret');
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    await markDispatchRejected(env);
    return badRequest('Invalid JSON body');
  }

  const parsed = validateDispatchIngressPayload(payload);
  if (!parsed.ok) {
    await markDispatchRejected(env);
    return badRequest(parsed.error);
  }

  const body = parsed.value;
  const epoch = now();
  const dispatchEpoch = body.scheduleAt && body.scheduleAt > 0 ? body.scheduleAt : epoch;
  const outboxIdempotency = `${body.correlationId}:${body.channel}:${scheduleSlot(dispatchEpoch)}`;
  const outboxPayload = {
    tenantId: body.tenantId,
    campaignId: body.campaignId,
    journeyId: body.journeyId ?? null,
    stepId: body.stepId,
    contact: {
      externalContactId: body.contactId,
      canonicalId: null,
    },
    channel: body.channel,
    schedule: {
      mode: 'scheduled',
      scheduledFor: new Date(dispatchEpoch * 1000).toISOString(),
      scheduleSlot: scheduleSlot(dispatchEpoch),
    },
    metadata: body.metadata ?? {},
    context: {
      subjectId: body.subjectId,
      actionType: body.actionType,
      correlationId: body.correlationId,
      ingress: 'matrikz-dispatch',
    },
  };

  await execute(
    env.DB,
    `INSERT OR IGNORE INTO channel_execution_outbox
      (tenant_id, campaign_id, journey_id, step_id, contact_id, channel, schedule_slot, idempotency_key, payload_json, status, attempt_count, next_attempt_at, last_error_code, last_error_message, correlation_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?, ?)`,
    [
      body.tenantId,
      body.campaignId,
      body.journeyId ?? null,
      body.stepId,
      body.contactId,
      body.channel,
      scheduleSlot(dispatchEpoch),
      outboxIdempotency,
      JSON.stringify(outboxPayload),
      SKRIP_OUTBOX_STATUS.PENDING,
      dispatchEpoch,
      body.correlationId,
      epoch,
      epoch,
    ],
  );

  await saveDispatchCorrelation(env, {
    tenantId: body.tenantId,
    subjectId: body.subjectId,
    correlationId: body.correlationId,
    actionType: body.actionType,
    campaignId: body.campaignId,
    stepId: body.stepId,
    channel: body.channel,
    contactId: body.contactId,
    createdAt: epoch,
  });

  await markDispatchAccepted(env, body.tenantId);

  return json({
    ok: true,
    data: {
      accepted: true,
      correlationId: body.correlationId,
      tenantId: body.tenantId,
      status: 'queued',
    },
  }, 202);
}
