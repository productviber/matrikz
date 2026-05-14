import { describe, expect, it } from 'vitest';
import { handleFcmDirectWebhook, handleMetaWhatsappDirectWebhook } from '../../src/routes/webhooks-direct';
import { createMockEnv, makeRequest } from '../helpers';

describe('direct provider webhooks', () => {
  it('processes FCM delivered outcomes and upserts push lineage', async () => {
    const env = createMockEnv();

    const req = makeRequest('POST', '/webhooks/providers/fcm', {
      messageId: 'push_msg_1',
      eventType: 'delivery_success',
      tenantId: 'tenant_acme',
      contactId: 'lead@acme.com',
      campaignId: 'cmp_1',
      stepId: 'step_1',
      occurredAt: '2026-05-14T10:00:00.000Z',
    });

    const res = await handleFcmDirectWebhook(req, env as any);
    expect(res.status).toBe(200);

    const lineageWrite = env.DB._queries.find((query) =>
      /INSERT INTO channel_message_lineage/i.test(query.sql)
      && query.params.includes('push')
      && query.params.includes('push_msg_1'),
    );
    expect(lineageWrite).toBeDefined();

    const telemetryQueue = env.DB._queries.find((query) =>
      /INSERT INTO telemetry_fallback_queue/i.test(query.sql)
      && query.params.some((param) => typeof param === 'string' && param.includes('outbound.push_delivered')),
    );
    expect(telemetryQueue).toBeDefined();
  });

  it('processes FCM failed outcomes, updates bounce reason, and emits fallback signal', async () => {
    const env = createMockEnv();
    env.DB.onQuery(/FROM outbound_campaigns/i, () => [{
      fallback_chain_json: '["email","push","whatsapp"]',
      channels_json: '["email","push","whatsapp"]',
    }]);

    const req = makeRequest('POST', '/webhooks/providers/fcm', {
      messageId: 'push_msg_2',
      eventType: 'delivery_failure',
      tenantId: 'tenant_acme',
      contactId: 'lead@acme.com',
      campaignId: 'cold-outreach-v1',
      stepId: 'step_2',
      occurredAt: '2026-05-14T10:05:00.000Z',
      reason: 'token_invalid',
    });

    const res = await handleFcmDirectWebhook(req, env as any);
    expect(res.status).toBe(200);

    const contactUpdate = env.DB._queries.find((query) =>
      /SET push_bounce_reason/i.test(query.sql)
      && query.params.includes('token_invalid'),
    );
    expect(contactUpdate).toBeDefined();

    const fallbackQueue = env.DB._queries.find((query) =>
      /INSERT INTO telemetry_fallback_queue/i.test(query.sql)
      && query.params.some((param) => typeof param === 'string' && param.includes('outbound.channel_fallback'))
      && query.params.some((param) => typeof param === 'string' && param.includes('"toChannel":"whatsapp"')),
    );
    expect(fallbackQueue).toBeDefined();
  });

  it('processes Meta WhatsApp read outcomes and updates engagement lifecycle', async () => {
    const env = createMockEnv();

    const req = makeRequest('POST', '/webhooks/providers/meta-whatsapp', {
      messageId: 'wa_msg_1',
      eventType: 'read',
      tenantId: 'tenant_acme',
      contactId: 'lead@acme.com',
      campaignId: 'cmp_wa',
      stepId: 'wa_step_1',
      occurredAt: '2026-05-14T10:10:00.000Z',
      providerMessageId: 'meta_ref_1',
    });

    const res = await handleMetaWhatsappDirectWebhook(req, env as any);
    expect(res.status).toBe(200);

    const whatsappUpdate = env.DB._queries.find((query) =>
      /SET whatsapp_last_read_at/i.test(query.sql)
      && query.params.includes('lead@acme.com'),
    );
    expect(whatsappUpdate).toBeDefined();

    const telemetryQueue = env.DB._queries.find((query) =>
      /INSERT INTO telemetry_fallback_queue/i.test(query.sql)
      && query.params.some((param) => typeof param === 'string' && param.includes('outbound.whatsapp_read')),
    );
    expect(telemetryQueue).toBeDefined();
  });

  it('returns accepted=false for unsupported direct provider events', async () => {
    const env = createMockEnv();

    const req = makeRequest('POST', '/webhooks/providers/meta-whatsapp', {
      messageId: 'wa_msg_unsupported',
      eventType: 'queued',
    });

    const res = await handleMetaWhatsappDirectWebhook(req, env as any);
    const body = await res.json() as { data: { accepted: boolean } };

    expect(res.status).toBe(200);
    expect(body.data.accepted).toBe(false);
  });
});
