import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { computeSkripSignature } from '../../src/lib/skrip/signing';
import { SKRIP_CONFIG } from '../../src/constants';
import { createMockCtx, createMockEnv, makeRequest, type MockEnv } from '../helpers';

describe('dispatch -> outcome-feedback loop', () => {
  let env: MockEnv;
  let ctx: ReturnType<typeof createMockCtx>;
  const webhookSecret = 'loop-secret-32-byte-length-value!!';

  beforeEach(() => {
    const feedbackFetch = vi.fn(async (_url: string, _init: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    env = createMockEnv({
      SYSTEM_TOKEN: 'system-token',
      INTERNAL_SECRET: 'internal-secret',
      SKRIP_WEBHOOK_SIGNING_SECRET: webhookSecret,
      OUTCOME_FEEDBACK_URL: 'https://matrikz/internal/outcome-feedback',
      AI_ENGINE: { fetch: feedbackFetch } as any,
      MATRIKZ: { fetch: feedbackFetch } as any,
    });
    ctx = createMockCtx();
    env.DB.onQuery(/INSERT INTO channel_message_lineage/i, () => []);
  });

  it('accepts dispatch then posts outcome-feedback with expected headers/body', async () => {
    const dispatchResponse = await worker.fetch(
      makeRequest('POST', '/dispatch', {
        tenantId: 'acme',
        subjectId: 'lead@acme.com',
        correlationId: 'corr-e2e-1',
        actionType: 'send_via_skrip',
        campaignId: 'cmp_1',
        stepId: 'step_1',
        channel: 'push',
        contactId: 'lead@acme.com',
      }, {
        'x-system-token': 'system-token',
        'x-internal-secret': 'internal-secret',
      }),
      env as any,
      ctx,
    );

    expect(dispatchResponse.status).toBe(202);

    const webhookPayload = {
      version: '1',
      eventId: 'evt_e2e_1',
      eventType: 'clicked',
      tenantId: 'acme',
      contactId: 'lead@acme.com',
      campaignId: 'cmp_1',
      stepId: 'step_1',
      channel: 'push',
      messageId: 'msg_e2e_1',
      occurredAt: new Date().toISOString(),
      sourceSystem: 'skrip',
      correlationId: 'corr-e2e-1',
      metadata: null,
    };

    const rawBody = JSON.stringify(webhookPayload);
    const timestamp = new Date().toISOString();
    const nonce = 'nonce-e2e-loop';
    const path = '/webhooks/skrip/v1/outcomes';
    const signature = await computeSkripSignature({
      method: 'POST',
      path,
      timestamp,
      nonce,
      rawBody,
      secret: webhookSecret,
    });

    const outcomeResponse = await worker.fetch(
      new Request(`https://test.workers.dev${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SKRIP_CONFIG.HEADER_TIMESTAMP]: timestamp,
          [SKRIP_CONFIG.HEADER_NONCE]: nonce,
          [SKRIP_CONFIG.HEADER_SIGNATURE]: signature,
        },
        body: rawBody,
      }),
      env as any,
      ctx,
    );

    expect(outcomeResponse.status).toBe(200);

    // Wait for all pending promises (including fire-and-forget sendOutcomeFeedback)
    await (ctx as any)._flush();

    const matrikz = env.MATRIKZ as { fetch: ReturnType<typeof vi.fn> };
    expect(matrikz.fetch).toHaveBeenCalledTimes(1);

    const call = matrikz.fetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://matrikz/internal/outcome-feedback');

    const sentHeaders = new Headers(call[1].headers as HeadersInit);
    expect(sentHeaders.get('x-internal-secret')).toBe('internal-secret');
    expect(sentHeaders.get('x-tenant-id')).toBe('acme');
    expect(sentHeaders.get('x-correlation-id')).toBe('corr-e2e-1');
    expect(sentHeaders.get('x-idempotency-key')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    const payload = JSON.parse(call[1].body as string) as {
      correlationId: string;
      tenantId: string;
      subjectId: string;
      actionTaken: string;
      outcomeMetric: string;
    };
    expect(payload.correlationId).toBe('corr-e2e-1');
    expect(payload.tenantId).toBe('acme');
    expect(payload.subjectId).toBe('lead@acme.com');
    expect(payload.actionTaken).toBe('send_via_skrip');
    expect(payload.outcomeMetric).toBe('clicked');
  });
});
