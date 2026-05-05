import { describe, expect, it } from 'vitest';
import {
  computeSegmentHash,
  detectSegmentContradictions,
  getChannelCompatibilityWarnings,
  resolveChannelIntent,
} from '../../src/lib/campaign-planning/shared';

describe('campaign planning shared helpers', () => {
  it('computes the same hash for semantically identical segment definitions', async () => {
    const first = {
      includeConditions: [
        { field: 'language', operator: 'equals', value: 'en' },
        { field: 'bookingCount', operator: 'gte', value: 3 },
      ],
      excludeConditions: [{ field: 'appInstalled', operator: 'equals', value: false }],
    } as const;
    const second = {
      includeConditions: [
        { field: 'bookingCount', operator: 'gte', value: 3 },
        { field: 'language', operator: 'equals', value: 'en' },
      ],
      excludeConditions: [{ field: 'appInstalled', operator: 'equals', value: false }],
    } as const;

    await expect(computeSegmentHash(first as any)).resolves.toBe(await computeSegmentHash(second as any));
  });

  it('detects contradictory filters', () => {
    const contradictions = detectSegmentContradictions({
      includeConditions: [{ field: 'language', operator: 'equals', value: 'en' }],
      excludeConditions: [{ field: 'language', operator: 'equals', value: 'en' }],
    });

    expect(contradictions).toEqual(['language both includes and excludes "en".']);
  });

  it('resolves the first available non-blocked channel and emits the email-only warning', () => {
    const profile = {
      hardBlockChannels: ['push'],
      preferredChannels: ['email'],
      fallbackChannels: [],
    } as const;

    expect(getChannelCompatibilityWarnings(profile as any)).toEqual([
      'Email-only intent is saved, but Skrip strategic dispatch currently sends directly through push, WhatsApp, Telegram, and SMS.',
    ]);
    expect(resolveChannelIntent(profile as any, { email: true, push: true })).toEqual({
      selectedChannel: 'email',
      orderedCandidates: ['email'],
      blockedChannels: ['push'],
    });
  });
});
