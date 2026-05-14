import { describe, expect, it } from 'vitest';
import { handleSkripOutcomeWebhook } from '../../src/routes/webhooks-skrip';
import { computeSkripSignature } from '../../src/lib/skrip/signing';
import { createMockEnv, makeRequest } from '../helpers';
import { SKRIP_CONFIG } from '../../src/constants';

describe('handleSkripOutcomeWebhook', () => {
  it('accepts a valid signed webhook and upserts message lineage', async () => {
    const env = createMockEnv({
      SKRIP_WEBHOOK_SIGNING_SECRET: 'skrip-webhook-secret',
    });

    const payload = {
      version: 'v1',
      eventId: 'evt_123',
      eventType: 'message.delivered',
      tenantId: 'tenant_acme',
      contactId: 'contact_123',
      campaignId: 'cmp_1',
      journeyId: 'journey_1',
      stepId: 'step_1',
      channel: 'push',
      messageId: 'msg_123',
      skripOutboundId: 'skrip_123',
      providerRef: 'provider_123',
      occurredAt: '2026-05-02T12:00:00.000Z',
      sourceSystem: 'skrip',
      correlationId: 'corr_123',
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const nonce = 'nonce_valid_123';
    const signature = await computeSkripSignature({
      method: 'POST',
      path: '/webhooks/skrip/v1/outcomes',
      timestamp,
      nonce,
      rawBody,
      secret: env.SKRIP_WEBHOOK_SIGNING_SECRET!,
    });

    const request = makeRequest('POST', '/webhooks/skrip/v1/outcomes', payload, {
      [SKRIP_CONFIG.HEADER_TIMESTAMP]: timestamp,
      [SKRIP_CONFIG.HEADER_NONCE]: nonce,
      [SKRIP_CONFIG.HEADER_SIGNATURE]: signature,
    });

    const response = await handleSkripOutcomeWebhook(request, env as any);
    const body = await response.json() as { data: any };

    expect(response.status).toBe(200);
    expect(body.data.accepted).toBe(true);
    const lineageWrite = env.DB._queries.find((query) =>
      /INSERT INTO channel_message_lineage/i.test(query.sql),
    );
    expect(lineageWrite).toBeDefined();
    expect(await env.KV_MARKETING.get('auth:nonce:skrip:nonce_valid_123')).toBe('1');
  });

  it('rejects webhook replay for the same nonce', async () => {
    const env = createMockEnv({
      SKRIP_WEBHOOK_SIGNING_SECRET: 'skrip-webhook-secret',
    });

    const payload = {
      eventId: 'evt_123',
      eventType: 'message.delivered',
      tenantId: 'tenant_acme',
      contactId: 'contact_123',
      campaignId: 'cmp_1',
      stepId: 'step_1',
      channel: 'push',
      messageId: 'msg_123',
      occurredAt: '2026-05-02T12:00:00.000Z',
      sourceSystem: 'skrip',
      correlationId: 'corr_123',
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const nonce = 'nonce_replay_123';
    const signature = await computeSkripSignature({
      method: 'POST',
      path: '/webhooks/skrip/v1/outcomes',
      timestamp,
      nonce,
      rawBody,
      secret: env.SKRIP_WEBHOOK_SIGNING_SECRET!,
    });

    const request = makeRequest('POST', '/webhooks/skrip/v1/outcomes', payload, {
      [SKRIP_CONFIG.HEADER_TIMESTAMP]: timestamp,
      [SKRIP_CONFIG.HEADER_NONCE]: nonce,
      [SKRIP_CONFIG.HEADER_SIGNATURE]: signature,
    });

    const first = await handleSkripOutcomeWebhook(request.clone() as any, env as any);
    const second = await handleSkripOutcomeWebhook(request, env as any);

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
  });

  it('marks push identity invalid when Skrip reports token_invalid failure', async () => {
    const env = createMockEnv({
      SKRIP_WEBHOOK_SIGNING_SECRET: 'skrip-webhook-secret',
    });

    const payload = {
      eventId: 'evt_fail_1',
      eventType: 'message.failed',
      tenantId: 'tenant_acme',
      contactId: 'contact_123',
      campaignId: 'cmp_1',
      stepId: 'step_1',
      channel: 'push',
      messageId: 'msg_fail_1',
      occurredAt: '2026-05-02T12:00:00.000Z',
      sourceSystem: 'skrip',
      correlationId: 'corr_fail_1',
      reason: 'token_invalid',
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const nonce = 'nonce_invalid_123';
    const signature = await computeSkripSignature({
      method: 'POST',
      path: '/webhooks/skrip/v1/outcomes',
      timestamp,
      nonce,
      rawBody,
      secret: env.SKRIP_WEBHOOK_SIGNING_SECRET!,
    });

    const request = makeRequest('POST', '/webhooks/skrip/v1/outcomes', payload, {
      [SKRIP_CONFIG.HEADER_TIMESTAMP]: timestamp,
      [SKRIP_CONFIG.HEADER_NONCE]: nonce,
      [SKRIP_CONFIG.HEADER_SIGNATURE]: signature,
    });

    const response = await handleSkripOutcomeWebhook(request, env as any);
    expect(response.status).toBe(200);
    const invalidationWrite = env.DB._queries.find((query) =>
      /UPDATE contact_channel_identities[\s\S]+registration_state = 'invalid'/i.test(query.sql),
    );
    expect(invalidationWrite).toBeDefined();
  });

  it('stores unmapped Skrip outcomes in dead letter instead of silently dropping them', async () => {
    const env = createMockEnv({
      SKRIP_WEBHOOK_SIGNING_SECRET: 'skrip-webhook-secret',
    });

    const payload = {
      eventId: 'evt_unmapped_1',
      eventType: 'message.buffered',
      tenantId: 'tenant_acme',
      contactId: 'contact_123',
      campaignId: 'cmp_1',
      stepId: 'step_1',
      channel: 'telegram',
      messageId: 'msg_unmapped_1',
      occurredAt: '2026-05-02T12:00:00.000Z',
      sourceSystem: 'skrip',
      correlationId: 'corr_unmapped_1',
    };

    const rawBody = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const nonce = 'nonce_unmapped_123';
    const signature = await computeSkripSignature({
      method: 'POST',
      path: '/webhooks/skrip/v1/outcomes',
      timestamp,
      nonce,
      rawBody,
      secret: env.SKRIP_WEBHOOK_SIGNING_SECRET!,
    });

    const request = makeRequest('POST', '/webhooks/skrip/v1/outcomes', payload, {
      [SKRIP_CONFIG.HEADER_TIMESTAMP]: timestamp,
      [SKRIP_CONFIG.HEADER_NONCE]: nonce,
      [SKRIP_CONFIG.HEADER_SIGNATURE]: signature,
    });

    const response = await handleSkripOutcomeWebhook(request, env as any);
    expect(response.status).toBe(200);

    const dlqWrite = env.DB._queries.find((query) =>
      /INSERT INTO channel_outcome_dead_letter/i.test(query.sql)
      && query.params.includes('unsupported_outcome_mapping'),
    );
    expect(dlqWrite).toBeDefined();
    expect(dlqWrite?.params).toContain(0);
  });

  it('emits channel fallback telemetry when push delivery fails and campaign has next channel', async () => {
    const env = createMockEnv({
      SKRIP_WEBHOOK_SIGNING_SECRET: 'skrip-webhook-secret',
    });

    env.DB.onQuery(/FROM outbound_campaigns/i, () => [{
      fallback_chain_json: '["email","push","whatsapp"]',
      channels_json: '["email","push","whatsapp"]',
    }]);

    const payload = {
      eventId: 'evt_push_failed_2',
      eventType: 'message.failed',
      tenantId: 'tenant_acme',
      contactId: 'contact_123',
      campaignId: 'cold-outreach-v1',
      stepId: 'step_1',
      channel: 'push',
      messageId: 'msg_push_failed_2',
      occurredAt: '2026-05-02T12:00:00.000Z',
      sourceSystem: 'skrip',
      correlationId: 'corr_push_failed_2',
      reason: 'device_offline',
    };

    const rawBody = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const nonce = 'nonce_push_failed_2';
    const signature = await computeSkripSignature({
      method: 'POST',
      path: '/webhooks/skrip/v1/outcomes',
      timestamp,
      nonce,
      rawBody,
      secret: env.SKRIP_WEBHOOK_SIGNING_SECRET!,
    });

    const request = makeRequest('POST', '/webhooks/skrip/v1/outcomes', payload, {
      [SKRIP_CONFIG.HEADER_TIMESTAMP]: timestamp,
      [SKRIP_CONFIG.HEADER_NONCE]: nonce,
      [SKRIP_CONFIG.HEADER_SIGNATURE]: signature,
    });

    const response = await handleSkripOutcomeWebhook(request, env as any);
    expect(response.status).toBe(200);

    const fallbackRollupWrite = env.DB._queries.find((query) =>
      /INSERT INTO telemetry_channel_daily/i.test(query.sql)
      && query.params.includes('system'),
    );
    expect(fallbackRollupWrite).toBeDefined();

    const fallbackQueueEntry = env.DB._queries.find((query) =>
      /INSERT INTO telemetry_fallback_queue/i.test(query.sql)
      && query.params.some((param) => typeof param === 'string' && param.includes('outbound.channel_fallback'))
      && query.params.some((param) => typeof param === 'string' && param.includes('"toChannel":"whatsapp"')),
    );
    expect(fallbackQueueEntry).toBeDefined();
  });
});