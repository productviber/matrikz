import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueueEligibleSkripChannels } from '../../src/lib/skrip/outbox';
import { dispatchOutboxBatch } from '../../src/lib/skrip/dispatcher';
import { handleSkripOutcomeWebhook } from '../../src/routes/webhooks-skrip';
import { computeSkripSignature } from '../../src/lib/skrip/signing';
import { SKRIP_CONFIG } from '../../src/constants';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';

type OutboxRow = {
  id: number;
  tenant_id: string;
  campaign_id: string;
  journey_id: string | null;
  step_id: string;
  contact_id: string;
  channel: string;
  schedule_slot: string;
  idempotency_key: string;
  payload_json: string;
  status: string;
  attempt_count: number;
  next_attempt_at: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  correlation_id: string;
  created_at: number;
  updated_at: number;
};

type LineageRow = {
  message_id: string;
  latest_status: string;
  provider_ref: string | null;
  skrip_outbound_id: string | null;
};

const mockFetch = vi.fn();

describe('Phase 2 Skrip roundtrip integration', () => {
  let env: MockEnv;
  let outboxRows: OutboxRow[];
  let lineageRows: LineageRow[];

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();

    env = createMockEnv({
      SKRIP_BASE_URL: 'https://skrip.example',
      SKRIP_SERVICE_TOKEN: 'skrip-service-token',
      SKRIP_SIGNING_SECRET: 'skrip-signing-secret-32-bytes-long',
      SKRIP_WEBHOOK_SIGNING_SECRET: 'skrip-webhook-secret',
      SKRIP_DEFAULT_ENABLEMENT: 'true',
    });

    outboxRows = [];
    lineageRows = [];

    env.DB.onQuery(/FROM contact_channel_identities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        external_contact_id: 'contact_1',
        canonical_id: 'skrip_can_1',
        channel: 'push',
        consent_state: 'opted_in',
        suppression_state: 'clear',
        availability_state: 'available',
        identity_confidence: 1,
        registration_state: 'registered',
        last_reconciled_at: null,
        created_at: 1,
        updated_at: 1,
      },
    ]);

    env.DB.onQuery(/FROM channel_authorities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        campaign_id: 'cmp_phase2',
        channel: 'push',
        authority: 'skrip',
        rollout_state: 'enabled',
        feature_flag_key: null,
        created_at: 1,
        updated_at: 1,
      },
    ]);

    env.DB.onQuery(/INSERT OR IGNORE INTO channel_execution_outbox/i, (params) => {
      const row: OutboxRow = {
        id: outboxRows.length + 1,
        tenant_id: String(params[0]),
        campaign_id: String(params[1]),
        journey_id: params[2] === null ? null : String(params[2]),
        step_id: String(params[3]),
        contact_id: String(params[4]),
        channel: String(params[5]),
        schedule_slot: String(params[6]),
        idempotency_key: String(params[7]),
        payload_json: String(params[8]),
        status: String(params[9]),
        attempt_count: 0,
        next_attempt_at: Number(params[10]) || null,
        last_error_code: null,
        last_error_message: null,
        correlation_id: String(params[11]),
        created_at: Number(params[12]),
        updated_at: Number(params[13]),
      };
      outboxRows.push(row);
      return [];
    });

    env.DB.onQuery(/FROM channel_execution_outbox[\s\S]*status IN/i, () =>
      outboxRows.filter((row) => row.status === 'pending' || row.status === 'retrying'),
    );

    env.DB.onQuery(/SELECT \* FROM channel_execution_outbox WHERE id =/i, (params) =>
      outboxRows.filter((row) => row.id === Number(params[0])),
    );

    env.DB.onQuery(/UPDATE channel_execution_outbox[\s\S]*SET status = \?, updated_at = \?/i, (params) => {
      const [status, updatedAt, id] = params;
      const row = outboxRows.find((candidate) => candidate.id === Number(id));
      if (row) {
        row.status = String(status);
        row.updated_at = Number(updatedAt);
      }
      return [];
    });

    env.DB.onQuery(/UPDATE channel_execution_outbox[\s\S]*SET status = \?,\s*attempt_count/i, (params) => {
      const [status, attemptCount, nextAttemptAt, _code, errorMessage, updatedAt, id] = params;
      const row = outboxRows.find((candidate) => candidate.id === Number(id));
      if (row) {
        row.status = String(status);
        row.attempt_count = Number(attemptCount);
        row.next_attempt_at = Number(nextAttemptAt);
        row.last_error_message = String(errorMessage);
        row.updated_at = Number(updatedAt);
      }
      return [];
    });

    env.DB.onQuery(/INSERT INTO channel_message_lineage/i, (params) => {
      const messageId = String(params[6]);
      const existing = lineageRows.find((row) => row.message_id === messageId);
      const latestStatus = params.length >= 11 && typeof params[10] === 'string'
        ? String(params[10])
        : 'accepted';
      const providerRef = params.length >= 9 && params[8] != null ? String(params[8]) : null;
      const skripOutboundId = params[7] != null ? String(params[7]) : null;
      if (existing) {
        existing.latest_status = latestStatus;
        existing.provider_ref = providerRef ?? existing.provider_ref;
        existing.skrip_outbound_id = skripOutboundId ?? existing.skrip_outbound_id;
      } else {
        lineageRows.push({
          message_id: messageId,
          latest_status: latestStatus,
          provider_ref: providerRef,
          skrip_outbound_id: skripOutboundId,
        });
      }
      return [];
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stages, dispatches, and finalizes a Skrip send via signed outcome webhook', async () => {
    const enqueued = await enqueueEligibleSkripChannels(env as any, {
      tenantId: 'default',
      campaignId: 'cmp_phase2',
      stepId: 'step_push_1',
      contactId: 'contact_1',
      scheduleAt: 1_714_658_560,
      context: { source: 'phase2_integration_test' },
    });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].status).toBe('pending');
    expect(enqueued[0].idempotencyKey).toContain('default:cmp_phase2:step_push_1:contact_1:push:');

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ messageId: 'msg_phase2_1', outboundId: 'ob_phase2_1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const dispatch = await dispatchOutboxBatch(env as any, 25);
    expect(dispatch.dispatched).toBe(1);
    expect(dispatch.failed).toBe(0);

    const sendCall = mockFetch.mock.calls[0];
    expect(sendCall).toBeDefined();
    expect(String(sendCall[0])).toContain('/v1/messages/send');

    const dispatchedLineage = lineageRows.find((row) => row.message_id === 'msg_phase2_1');
    expect(dispatchedLineage?.latest_status).toBe('accepted');

    const webhookPayload = {
      version: 'v1',
      eventId: 'evt_phase2_1',
      eventType: 'message.delivered',
      tenantId: 'default',
      contactId: 'contact_1',
      campaignId: 'cmp_phase2',
      journeyId: null,
      stepId: 'step_push_1',
      channel: 'push',
      messageId: 'msg_phase2_1',
      skripOutboundId: 'ob_phase2_1',
      providerRef: 'provider_ref_phase2_1',
      occurredAt: '2026-05-02T12:00:00.000Z',
      sourceSystem: 'skrip',
      correlationId: 'corr_phase2_1',
    };
    const rawBody = JSON.stringify(webhookPayload);
    const timestamp = new Date().toISOString();
    const nonce = 'phase2-nonce-1';

    const signature = await computeSkripSignature({
      method: 'POST',
      path: '/webhooks/skrip/v1/outcomes',
      timestamp,
      nonce,
      rawBody,
      secret: env.SKRIP_WEBHOOK_SIGNING_SECRET!,
    });

    const webhookRequest = makeRequest('POST', '/webhooks/skrip/v1/outcomes', webhookPayload, {
      [SKRIP_CONFIG.HEADER_TIMESTAMP]: timestamp,
      [SKRIP_CONFIG.HEADER_NONCE]: nonce,
      [SKRIP_CONFIG.HEADER_SIGNATURE]: signature,
    });

    const webhookResponse = await handleSkripOutcomeWebhook(webhookRequest, env as any);
    expect(webhookResponse.status).toBe(200);

    const finalLineage = lineageRows.find((row) => row.message_id === 'msg_phase2_1');
    expect(finalLineage?.latest_status).toBe('message.delivered');
    expect(finalLineage?.provider_ref).toBe('provider_ref_phase2_1');
  });
});
