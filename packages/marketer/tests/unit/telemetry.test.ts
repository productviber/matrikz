import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KV_PREFIX } from '../../src/constants';
import { evaluateOutboundTelemetryAlerts, getOutboundTelemetryHealth } from '../../src/lib/telemetry';
import { createMockEnv, type MockEnv } from '../helpers';

describe('telemetry utility', () => {
  let env: MockEnv;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-14T12:00:00Z'));
    env = createMockEnv();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('computes outbound telemetry health snapshot from metrics tables', async () => {
    env.DB.onQuery(/FROM service_binding_metrics/i, () => [{
      attempts: 10,
      success: 9,
      failures: 1,
      avg_latency_ms: 1234,
    }]);

    env.DB.onQuery(/FROM telemetry_channel_daily/i, () => [{
      channel: 'email',
      sent_count: 20,
      delivered_count: 15,
      bounced_count: 2,
      failed_count: 1,
      complained_count: 1,
      unsubscribed_count: 1,
      dismissed_count: 0,
    }]);

    env.DB.onQuery(/FROM telemetry_fallback_queue/i, () => [{
      pending_count: 3,
      retryable_count: 2,
      dead_letter_count: 1,
      oldest_created_at: Math.floor(Date.now() / 1000) - 120,
    }]);

    const snapshot = await getOutboundTelemetryHealth(env as any);

    expect(snapshot.sendSuccessRate).toBe(90);
    expect(snapshot.webhookReceiptRate).toBe(100);
    expect(snapshot.avgLatencyMs).toBe(1234);
    expect(snapshot.errorCount24h).toBe(1);

    expect(snapshot.channels).toHaveLength(1);
    expect(snapshot.channels[0].channel).toBe('email');
    expect(snapshot.channels[0].sendSuccessRate).toBe(75);
    expect(snapshot.channels[0].webhookReceiptRate).toBe(100);

    expect(snapshot.fallbackQueue.pending).toBe(3);
    expect(snapshot.fallbackQueue.retryable).toBe(2);
    expect(snapshot.fallbackQueue.deadLetter).toBe(1);
    expect(snapshot.fallbackQueue.oldestPendingAgeSec).toBe(120);

    expect(snapshot.breaches).toEqual(['send_success_rate']);
  });

  it('emits and suppresses repeated outbound telemetry alerts', async () => {
    env.DB.onQuery(/FROM service_binding_metrics/i, () => [{
      attempts: 10,
      success: 4,
      failures: 2001,
      avg_latency_ms: 15001,
    }]);

    env.DB.onQuery(/FROM telemetry_channel_daily/i, () => [{
      sent_count: 100,
      delivered_count: 20,
      bounced_count: 5,
      failed_count: 5,
      complained_count: 0,
      unsubscribed_count: 0,
      dismissed_count: 0,
    }]);

    env.DB.onQuery(/FROM telemetry_fallback_queue/i, () => [{
      pending_count: 8,
      retryable_count: 6,
      dead_letter_count: 2,
      oldest_created_at: Math.floor(Date.now() / 1000) - 300,
    }]);

    const first = await evaluateOutboundTelemetryAlerts(env as any);

    expect(first.snapshot.breaches).toEqual([
      'send_success_rate',
      'webhook_receipt_rate',
      'avg_latency_ms',
      'error_count_24h',
    ]);
    expect(first.emitted).toEqual(first.snapshot.breaches);

    for (const breach of first.emitted) {
      const key = `${KV_PREFIX.OUTBOUND_ALERT_SUPPRESS}${breach}`;
      expect(await env.KV_MARKETING.get(key)).not.toBeNull();
    }

    const second = await evaluateOutboundTelemetryAlerts(env as any);
    expect(second.snapshot.breaches).toEqual(first.snapshot.breaches);
    expect(second.emitted).toEqual([]);
  });

  it('defaults to healthy rates when no telemetry samples are available', async () => {
    const snapshot = await getOutboundTelemetryHealth(env as any);

    expect(snapshot.totals.bindingAttempts).toBe(0);
    expect(snapshot.totals.sent).toBe(0);
    expect(snapshot.sendSuccessRate).toBe(100);
    expect(snapshot.webhookReceiptRate).toBe(100);
    expect(snapshot.breaches).toEqual([]);
  });

  it('surfaces schema-coercion and dead-letter quality breaches', async () => {
    env.DB.onQuery(/binding = 'schema_alignment'/i, () => [{
      coercion_count: 2,
    }]);

    env.DB.onQuery(/binding IN \('analytics_events', 'analytics_events_replay'\)/i, () => [{
      attempts: 20,
      success: 20,
      failures: 0,
      avg_latency_ms: 250,
    }]);

    env.DB.onQuery(/FROM telemetry_channel_daily/i, () => [{
      channel: 'email',
      sent_count: 100,
      delivered_count: 98,
      bounced_count: 1,
      failed_count: 1,
      complained_count: 0,
      unsubscribed_count: 0,
      dismissed_count: 0,
      avg_latency_ms: 150,
      latency_samples: 20,
    }]);

    env.DB.onQuery(/FROM telemetry_fallback_queue/i, () => [{
      pending_count: 0,
      retryable_count: 0,
      dead_letter_count: 0,
      oldest_created_at: null,
    }]);

    env.DB.onQuery(/FROM channel_outcome_dead_letter/i, () => [{
      dead_letter_count: 30,
      retryable_dead_letter_count: 20,
      non_retryable_dead_letter_count: 10,
      unsupported_outcome_count: 3,
      reverse_emit_failure_count: 2,
    }]);

    const snapshot = await getOutboundTelemetryHealth(env as any);

    expect(snapshot.quality.deadLetterCount24h).toBe(30);
    expect(snapshot.schemaAlignment.coercedCount24h).toBe(2);
    expect(snapshot.breaches).toContain('dead_letter_24h');
    expect(snapshot.breaches).toContain('schema_alignment');
  });
});
