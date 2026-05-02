/**
 * Skrip Dispatcher Tests
 *
 * Covers: pending row dispatch, DLQ on max-retry exhaustion, dry-run skip,
 * circuit-open skip, and the manual admin sweep trigger.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { dispatchOutboxBatch, runDispatcherSweep } from '../../src/lib/skrip/dispatcher';
import { createMockEnv, type MockEnv } from '../helpers';

const mockFetch = vi.fn();
beforeEach(() => { mockFetch.mockClear(); vi.stubGlobal('fetch', mockFetch); });
afterEach(() => vi.unstubAllGlobals());

// ── Helpers ────────────────────────────────────────────────────────────────

function makeOutboxRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    tenant_id: 'default',
    campaign_id: 'cmp_1',
    journey_id: null,
    step_id: 'step_1',
    contact_id: 'lead@acme.com',
    channel: 'push',
    schedule_slot: '2024-05-02T10:00Z',
    idempotency_key: 'default:cmp_1:step_1:lead@acme.com:push:2024-05-02T10:00Z',
    payload_json: JSON.stringify({
      tenantId: 'default',
      campaignId: 'cmp_1',
      stepId: 'step_1',
      contact: { externalContactId: 'lead@acme.com', canonicalId: 'skrip_can_1' },
      channel: 'push',
      schedule: { mode: 'scheduled', scheduledFor: '2024-05-02T10:00:00.000Z', scheduleSlot: '2024-05-02T10:00Z' },
      metadata: { domain: 'acme.com', dryRun: false },
      context: {},
    }),
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    correlation_id: 'test-corr',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

// ── dispatchOutboxBatch() ──────────────────────────────────────────────────

describe('dispatchOutboxBatch()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv({
      SKRIP_BASE_URL: 'https://api.skrip.example',
      SKRIP_SERVICE_TOKEN: 'tok_test',
      SKRIP_SIGNING_SECRET: 'secret_32_bytes_long_test_string!',
    });
  });

  it('returns empty result when outbox is empty', async () => {
    const result = await dispatchOutboxBatch(env as any, 10);
    expect(result).toEqual({ total: 0, dispatched: 0, skipped: 0, failed: 0, errors: [] });
  });

  it('dispatches a pending row and marks it dispatched', async () => {
    env.DB.onQuery(/channel_execution_outbox[\s\S]*?status IN/, () => [makeOutboxRow()]);
    env.DB.onQuery(/channel_execution_outbox[\s\S]*?WHERE id/, () => [makeOutboxRow()]);

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ messageId: 'msg_1', outboundId: 'ob_1' }), { status: 200 }),
    );

    const result = await dispatchOutboxBatch(env as any, 10);

    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);

    const updateQ = env.DB._queries.find(
      (q) => q.sql.includes('UPDATE channel_execution_outbox') && q.params.includes('dispatched'),
    );
    expect(updateQ).toBeDefined();
  });

  it('skips a dry_run row without sending', async () => {
    env.DB.onQuery(/channel_execution_outbox[\s\S]*?status IN/, () => [
      makeOutboxRow({ status: 'dry_run' }),
    ]);

    const result = await dispatchOutboxBatch(env as any, 10);

    expect(result.skipped).toBe(1);
    expect(result.dispatched).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('marks row retrying on first Skrip error', async () => {
    env.DB.onQuery(/channel_execution_outbox[\s\S]*?status IN/, () => [makeOutboxRow()]);

    mockFetch.mockResolvedValueOnce(
      new Response('Service Unavailable', { status: 503 }),
    );

    const result = await dispatchOutboxBatch(env as any, 10);

    expect(result.failed).toBe(1);
    const retryQ = env.DB._queries.find(
      (q) => q.sql.includes('UPDATE channel_execution_outbox') && q.params.includes('retrying'),
    );
    expect(retryQ).toBeDefined();
  });

  it('sends to DLQ when max retries exceeded', async () => {
    env.DB.onQuery(/channel_execution_outbox[\s\S]*?status IN/, () => [
      makeOutboxRow({ attempt_count: 3 }),
    ]);

    mockFetch.mockResolvedValueOnce(
      new Response('Error', { status: 500 }),
    );

    const result = await dispatchOutboxBatch(env as any, 10);

    expect(result.failed).toBe(1);
    const dlqInsert = env.DB._queries.find(
      (q) => q.sql.includes('channel_outcome_dead_letter') && q.sql.toUpperCase().includes('INSERT'),
    );
    expect(dlqInsert).toBeDefined();
  });

  it('skips all rows when Skrip client is not configured', async () => {
    env = createMockEnv(); // no Skrip env vars
    env.DB.onQuery(/channel_execution_outbox[\s\S]*?status IN/, () => [makeOutboxRow()]);

    const result = await dispatchOutboxBatch(env as any, 10);

    expect(result.skipped).toBe(1);
    expect(result.dispatched).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── runDispatcherSweep() ───────────────────────────────────────────────────

describe('runDispatcherSweep()', () => {
  it('returns preview without dispatching when dryRunOnly=true', async () => {
    const env = createMockEnv({
      SKRIP_BASE_URL: 'https://api.skrip.example',
      SKRIP_SERVICE_TOKEN: 'tok_test',
      SKRIP_SIGNING_SECRET: 'secret_32_bytes_long_test_string!',
    });

    env.DB.onQuery(/channel_execution_outbox[\s\S]*?status IN/, () => [makeOutboxRow()]);

    const result = await runDispatcherSweep(env as any, { batchSize: 10, dryRunOnly: true });

    expect(result.total).toBe(1);
    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
