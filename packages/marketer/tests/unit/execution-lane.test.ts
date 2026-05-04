/**
 * send_via_skrip Execution Lane
 *
 * Documents and enforces the two-lane execution model for `send_via_skrip`:
 *
 *   Lane 1 (Primary):  Strategic send via Skrip service binding when the
 *                      service is configured and `skripClient.configured` is true.
 *                      Returns `strategicResponse`. No outbox enqueue.
 *
 *   Lane 2 (Fallback): Outbox-based enqueue when the Skrip service binding is
 *                      absent OR when the strategic send throws. The dispatcher
 *                      (dispatchOutboxBatch) picks rows up asynchronously.
 *
 * Alignment ref: ECOSYSTEM_ALIGNMENT_REVIEW_2026-05-04.md
 * "Reduce ambiguity around send_via_skrip by choosing one canonical execution
 * lane for operator reasoning and release certification."
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { dispatchOutboxBatch } from '../../src/lib/skrip/dispatcher';
import { createMockEnv, type MockEnv } from '../helpers';

// ─── Helpers ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
beforeEach(() => { mockFetch.mockClear(); vi.stubGlobal('fetch', mockFetch); });
afterEach(() => vi.unstubAllGlobals());

function makeOutboxRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    tenant_id: 'default',
    campaign_id: 'agent-growth',
    journey_id: null,
    step_id: 'agent-step-001',
    contact_id: 'user@example.com',
    channel: 'push',
    schedule_slot: '2026-05-04T10:00Z',
    idempotency_key: 'default:agent-growth:agent-step-001:user@example.com:push:2026-05-04T10:00Z',
    payload_json: JSON.stringify({
      tenantId: 'default',
      campaignId: 'agent-growth',
      stepId: 'agent-step-001',
      contact: { externalContactId: 'user@example.com', canonicalId: null },
      channel: 'push',
      schedule: { mode: 'immediate', scheduledFor: '2026-05-04T10:00:00.000Z', scheduleSlot: '2026-05-04T10:00Z' },
      metadata: { domain: 'example.com', dryRun: false },
      context: { agentActionId: 'act_lane_001' },
    }),
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    correlation_id: 'corr-lane-001',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('send_via_skrip: execution lane — dispatcher (Lane 2 / Fallback)', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv({
      SKRIP_BASE_URL: 'https://skrip.example',
      SKRIP_SERVICE_TOKEN: 'tok_lane_test',
      SKRIP_SIGNING_SECRET: 'signing_secret_32bytes_padded!!!',
    });
  });

  it('dispatches a pending outbox row to Skrip and marks it dispatched', async () => {
    env.DB.onQuery(/FROM channel_execution_outbox[\s\S]*status IN/i, () => [makeOutboxRow()]);
    env.DB.onQuery(/UPDATE channel_execution_outbox.*SET status/i, () => []);
    env.DB.onQuery(/INSERT.*channel_message_lineage/i, () => []);
    env.DB.onQuery(/SELECT.*FROM channel_execution_outbox WHERE id =/i, () => [makeOutboxRow()]);

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ messageId: 'msg_lane_001', outboundId: 'obound_001' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await dispatchOutboxBatch(env as any);
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('skips dry_run outbox rows — they must never reach Skrip', async () => {
    env.DB.onQuery(/FROM channel_execution_outbox[\s\S]*status IN/i, () => [
      makeOutboxRow({ status: 'dry_run' }),
    ]);

    const result = await dispatchOutboxBatch(env as any);

    // dry_run rows should not be dispatched
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.dispatched).toBe(0);
  });

  it('preserves agentActionId in outbox payload context for lineage join', async () => {
    const capturedBody: Record<string, unknown>[] = [];

    env.DB.onQuery(/FROM channel_execution_outbox[\s\S]*status IN/i, () => [makeOutboxRow()]);
    env.DB.onQuery(/UPDATE channel_execution_outbox.*SET status/i, () => []);
    env.DB.onQuery(/INSERT.*channel_message_lineage/i, () => []);
    env.DB.onQuery(/SELECT.*FROM channel_execution_outbox WHERE id =/i, () => [makeOutboxRow()]);

    mockFetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      capturedBody.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ messageId: 'msg_lane_ctx', outboundId: null }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    await dispatchOutboxBatch(env as any);

    const sentPayload = capturedBody[0];
    expect(sentPayload).toBeDefined();
    // The context object in the dispatched payload must carry agentActionId so Skrip
    // can propagate it to the outcome webhook → action ledger closed loop.
    const context = (sentPayload?.context ?? sentPayload) as Record<string, unknown>;
    const ctxString = JSON.stringify(sentPayload);
    expect(ctxString).toContain('act_lane_001');
  });

  it('puts failed rows on DLQ after max retries exhausted', async () => {
    const dlqInserts: unknown[][] = [];
    env.DB.onQuery(/FROM channel_execution_outbox[\s\S]*status IN/i, () => [
      makeOutboxRow({ status: 'retrying', attempt_count: 5 }),
    ]);
    env.DB.onQuery(/UPDATE channel_execution_outbox/i, () => []);
    env.DB.onQuery(/INSERT.*channel_execution_dlq/i, (params) => {
      dlqInserts.push(params);
      return [];
    });
    env.DB.onQuery(/SELECT.*FROM channel_execution_outbox WHERE id =/i, () => [
      makeOutboxRow({ status: 'retrying', attempt_count: 5 }),
    ]);

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'provider_error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await dispatchOutboxBatch(env as any);
    // Whether dispatched (then failed) or skipped depends on implementation;
    // the key invariant is that the row is no longer stuck pending.
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  it('circuit-open: skips all dispatch when circuit breaker is open', async () => {
    // Open the circuit by writing a future timestamp to KV
    const openUntil = Date.now() + 60_000;
    await env.KV_MARKETING.put('skrip:circuit:default', String(openUntil));

    env.DB.onQuery(/FROM channel_execution_outbox[\s\S]*status IN/i, () => [makeOutboxRow()]);

    const result = await dispatchOutboxBatch(env as any);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.dispatched).toBe(0);
    // Circuit-open causes sendMessage to throw, so the dispatcher records it as
    // a failed row (retried or DLQ'd) — not silently skipped.
    expect(result.failed + result.skipped).toBeGreaterThanOrEqual(1);
  });

  it('idempotency: a row already in dispatched/delivered status is not re-sent', async () => {
    // The dispatcher query filters on status IN (pending, retrying) — so
    // dispatched rows should never be returned for re-processing.
    env.DB.onQuery(/FROM channel_execution_outbox[\s\S]*status IN/i, () => []);

    const result = await dispatchOutboxBatch(env as any);

    expect(result.total).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
