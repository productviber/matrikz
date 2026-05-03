import { describe, expect, it } from 'vitest';
import { loadSubjectContextForDecision } from '../../src/lib/growth/context';
import { createMockEnv } from '../helpers';

describe('subject context loader', () => {
  it('includes active product-user channel identities and push registration state', async () => {
    const env = createMockEnv();
    env.DB.onQuery(/LEFT JOIN agent_action_outcomes/i, () => [
      {
        action_id: 'act_1',
        proposed_action: 'enroll_sequence',
        confidence: 82,
        executed_at: 100,
        outcome_type: 'conversion',
        attribution_strength: 'strong_time_proximity',
      },
    ]);
    env.DB.onQuery(/FROM growth_signals/i, () => [
      { signal_type: 'trial_expiring_high_intent' },
    ]);
    env.DB.onQuery(/FROM marketing_contacts/i, () => [{ status: 'trial' }]);
    env.DB.onQuery(/FROM contact_channel_identities/i, () => [
      {
        channel: 'push',
        registrationState: 'registered',
        availabilityState: 'available',
        consentState: 'opted_in',
      },
      {
        channel: 'sms',
        registrationState: 'registered',
        availabilityState: 'available',
        consentState: 'opted_in',
      },
    ]);

    const subjectContext = await loadSubjectContextForDecision(env as any, 'default', 'lead@acme.com');

    expect(subjectContext.pushRegistered).toBe(true);
    expect(subjectContext.activeChannels).toEqual([
      {
        channel: 'push',
        registrationState: 'registered',
        availabilityState: 'available',
        consentState: 'opted_in',
      },
      {
        channel: 'sms',
        registrationState: 'registered',
        availabilityState: 'available',
        consentState: 'opted_in',
      },
    ]);
    expect(subjectContext.activeSignalCount).toBe(1);
    expect(subjectContext.lifecycleStage).toBe('trial');
  });
});
