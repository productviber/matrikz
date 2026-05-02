import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, GROWTH_SIGNAL_TYPE } from '../../src/constants';
import { materializeGrowthSignalsFromEvent, upsertGrowthSignal } from '../../src/lib/growth/signals';
import { createMockEnv } from '../helpers';

function installGrowthSignalPersistence(env: ReturnType<typeof createMockEnv>) {
  let inserted: unknown[] = [];
  env.DB.onQuery(/INSERT INTO growth_signals/i, (params) => {
    inserted = params;
    return [];
  });
  env.DB.onQuery(/SELECT \* FROM growth_signals WHERE signal_id/i, (params) => [{
    id: 1,
    signal_id: params[0],
    tenant_id: inserted[1] ?? 'default',
    subject_type: inserted[2] ?? 'contact',
    subject_id: inserted[3] ?? 'lead@example.com',
    signal_type: inserted[4] ?? 'test_signal',
    severity: inserted[5] ?? 'medium',
    confidence: inserted[6] ?? 65,
    detected_at: inserted[7] ?? 1,
    expires_at: inserted[8] ?? 2,
    source_event_id: inserted[9] ?? null,
    evidence_json: inserted[10] ?? '{}',
    status: inserted[11] ?? 'active',
    created_at: inserted[12] ?? 1,
    updated_at: inserted[13] ?? 1,
  }]);
}

describe('growth signals', () => {
  it('upserts a deterministic active signal view with parsed evidence', async () => {
    const env = createMockEnv();
    installGrowthSignalPersistence(env);

    const signal = await upsertGrowthSignal(env as any, {
      subjectType: 'domain',
      subjectId: 'Acme.com',
      signalType: GROWTH_SIGNAL_TYPE.AUDIT_COMPLETED_NO_SIGNUP,
      severity: 'high',
      confidence: 82,
      evidence: { score: 41 },
      detectedAt: 1_714_652_800,
    });

    expect(signal.signal_id).toMatch(/^sig_/);
    expect(signal.subject_id).toBe('acme.com');
    expect(signal.status).toBe('active');
    expect(signal.evidence.score).toBe(41);
  });

  it('materializes audit.completed into an audit_completed_no_signup signal', async () => {
    const env = createMockEnv();
    installGrowthSignalPersistence(env);

    const signals = await materializeGrowthSignalsFromEvent(env as any, EVENT_TYPES.AUDIT_COMPLETED, {
      domain: 'acme.com',
      score: 52,
      grade: 'D',
      url: 'https://acme.com',
    }, '2026-05-02T12:00:00.000Z');

    expect(signals).toHaveLength(1);
    expect(signals[0].signal_type).toBe(GROWTH_SIGNAL_TYPE.AUDIT_COMPLETED_NO_SIGNUP);
    expect(signals[0].severity).toBe('high');
  });

  it('materializes signup and outbound click adoption signals', async () => {
    const env = createMockEnv();
    installGrowthSignalPersistence(env);

    const signupSignals = await materializeGrowthSignalsFromEvent(env as any, EVENT_TYPES.USER_SIGNUP, {
      userId: 'user_123',
      provider: 'google',
    }, '2026-05-02T12:00:00.000Z');
    expect(signupSignals[0].signal_type).toBe(GROWTH_SIGNAL_TYPE.SIGNUP_NO_SITE_CONNECTED);

    const clickSignals = await materializeGrowthSignalsFromEvent(env as any, EVENT_TYPES.OUTBOUND_EMAIL_CLICKED, {
      email: 'lead@acme.com',
      link: 'https://visibility.clodo.dev/pricing',
    }, '2026-05-02T12:00:00.000Z');
    expect(clickSignals[0].signal_type).toBe(GROWTH_SIGNAL_TYPE.COLD_CLICKED_NO_REPLY);
    expect(clickSignals[0].severity).toBe('high');
  });
});