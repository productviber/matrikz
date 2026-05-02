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
});