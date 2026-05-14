/**
 * Channel Orchestrator Tests
 *
 * Tests for multi-channel outreach coordination:
 *   - storeProspectChannels() — detect & persist channels
 *   - recordChannelAttempt() — track outreach attempts
 *   - executeSecondaryChannels() — cascade after email send
 *   - executeWithoutEmail() — fallback cascade (no email)
 *   - getProspectChannels() / getChannelStats() — admin queries
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  CHANNEL_PRIORITY,
  storeProspectChannels,
  recordChannelAttempt,
  executeSecondaryChannels,
  executeWithoutEmail,
  getProspectChannels,
  getChannelStats,
} from '../../src/lib/channel-orchestrator';
import { createMockEnv, type MockEnv } from '../helpers';
import type { ContactForm, SocialHandles } from '../../src/types';

// ── Mock global fetch for contact form submissions ──

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Helper: build standard test data ──

const testDomain = 'acme.com';
const testEmail = 'hello@acme.com';

const testForm: ContactForm = {
  action: 'https://acme.com/api/contact',
  method: 'POST',
  fields: ['name', 'email', 'message'],
  pageUrl: 'https://acme.com/contact',
  type: 'contact',
};

const testSocials: SocialHandles = {
  twitter: 'https://twitter.com/acmeinc',
  linkedin: 'https://linkedin.com/company/acme',
  facebook: null,
  github: 'https://github.com/acme',
  instagram: null,
};

const testContext = {
  domain: testDomain,
  companyName: 'Acme Inc',
  auditScore: 65,
  auditGrade: 'C',
  issueCount: 12,
  passCount: 8,
  contactForms: [testForm],
  socialHandles: testSocials,
};

// ─────────────────────────────────────────────────────────────────────────
// storeProspectChannels()
// ─────────────────────────────────────────────────────────────────────────

describe('storeProspectChannels()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('stores email channel when contactEmail provided', async () => {
    const count = await storeProspectChannels(env as any, {
      domain: testDomain,
      contactEmail: testEmail,
      contactForms: [],
      socialHandles: {},
      techStack: [],
    });

    expect(count).toBe(1);
    const insertQuery = env.DB._queries.find(q => q.sql.includes('INSERT'));
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.params).toContain(testEmail);
    // 'email' is hardcoded in SQL, not a bind param
    expect(insertQuery!.sql).toContain("'email'");
  });

  it('stores contact_form channel when forms provided', async () => {
    const count = await storeProspectChannels(env as any, {
      domain: testDomain,
      contactEmail: null,
      contactForms: [testForm],
      socialHandles: {},
      techStack: [],
    });

    expect(count).toBe(1);
    const insertQuery = env.DB._queries.find(q =>
      q.sql.includes('INSERT') && q.sql.includes("'contact_form'")
    );
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.params).toContain(testForm.action);
  });

  it('stores social handle channels', async () => {
    const count = await storeProspectChannels(env as any, {
      domain: testDomain,
      contactEmail: null,
      contactForms: [],
      socialHandles: testSocials,
      techStack: [],
    });

    // twitter, linkedin, github = 3 non-null handles
    expect(count).toBe(3);
    const twitterQuery = env.DB._queries.find(q =>
      q.sql.includes('INSERT') && q.params.includes('twitter')
    );
    expect(twitterQuery).toBeDefined();
    expect(twitterQuery!.params).toContain('https://twitter.com/acmeinc');
  });

  it('stores chat widget channels from tech stack', async () => {
    const count = await storeProspectChannels(env as any, {
      domain: testDomain,
      contactEmail: null,
      contactForms: [],
      socialHandles: {},
      techStack: ['Intercom', 'Drift'],
    });

    expect(count).toBe(2);
    const intercomQuery = env.DB._queries.find(q =>
      q.sql.includes('INSERT') && q.params.includes('chat_intercom')
    );
    const driftQuery = env.DB._queries.find(q =>
      q.sql.includes('INSERT') && q.params.includes('chat_drift')
    );
    expect(intercomQuery).toBeDefined();
    expect(driftQuery).toBeDefined();
  });

  it('stores all channel types at once', async () => {
    const count = await storeProspectChannels(env as any, {
      domain: testDomain,
      contactEmail: testEmail,
      contactForms: [testForm],
      socialHandles: testSocials,
      techStack: ['Intercom'],
    });

    // email(1) + form(1) + twitter,linkedin,github(3) + chat_intercom(1) = 6
    expect(count).toBe(6);
  });

  it('skips null social handles', async () => {
    const count = await storeProspectChannels(env as any, {
      domain: testDomain,
      contactEmail: null,
      contactForms: [],
      socialHandles: { twitter: null, linkedin: null, facebook: null, github: null, instagram: null },
      techStack: [],
    });

    expect(count).toBe(0);
  });

  it('skips unrecognised tech stack entries', async () => {
    const count = await storeProspectChannels(env as any, {
      domain: testDomain,
      contactEmail: null,
      contactForms: [],
      socialHandles: {},
      techStack: ['React', 'WordPress', 'Tailwind'],
    });

    expect(count).toBe(0);
  });

  it('uses correct priority values', async () => {
    await storeProspectChannels(env as any, {
      domain: testDomain,
      contactEmail: testEmail,
      contactForms: [testForm],
      socialHandles: { twitter: 'https://twitter.com/test', linkedin: null, facebook: null, github: null, instagram: null },
      techStack: [],
    });

    // Check email priority = 1 (email is hardcoded in SQL, priority is a param)
    const emailQ = env.DB._queries.find(q => q.sql.includes("'email'") && q.params.includes(CHANNEL_PRIORITY.email));
    expect(emailQ).toBeDefined();

    // Check contact_form priority = 2 (contact_form is hardcoded in SQL)
    const formQ = env.DB._queries.find(q => q.sql.includes("'contact_form'") && q.params.includes(CHANNEL_PRIORITY.contact_form));
    expect(formQ).toBeDefined();

    // Check twitter priority = 3 (social handle types are bind params)
    const twitterQ = env.DB._queries.find(q => q.params.includes('twitter') && q.params.includes(CHANNEL_PRIORITY.twitter));
    expect(twitterQ).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// recordChannelAttempt()
// ─────────────────────────────────────────────────────────────────────────

describe('recordChannelAttempt()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('inserts an attempt row with all fields', async () => {
    await recordChannelAttempt(env as any, {
      domain: testDomain,
      contactEmail: testEmail,
      channelType: 'email',
      channelValue: testEmail,
      stepKey: 'cold-outreach-step1',
      campaignSlug: 'test-campaign',
      status: 'delivered',
      responseCode: 200,
    });

    expect(env.DB._queries).toHaveLength(1);
    const q = env.DB._queries[0];
    expect(q.sql).toContain('INSERT INTO channel_attempts');
    expect(q.params).toContain(testDomain);
    expect(q.params).toContain(testEmail);
    expect(q.params).toContain('email');
    expect(q.params).toContain('delivered');
    expect(q.params).toContain(200);
  });

  it('handles null optional fields', async () => {
    await recordChannelAttempt(env as any, {
      domain: testDomain,
      contactEmail: null,
      channelType: 'contact_form',
      channelValue: 'https://acme.com/contact',
      status: 'failed',
      error: 'timeout',
    });

    const q = env.DB._queries[0];
    expect(q.params).toContain(null); // stepKey
    expect(q.params).toContain('failed');
    expect(q.params).toContain('timeout');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// executeSecondaryChannels()
// ─────────────────────────────────────────────────────────────────────────

describe('executeSecondaryChannels()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv({ ENVIRONMENT: 'production' as any });
  });

  it('records email attempt even without secondary channels', async () => {
    const used = await executeSecondaryChannels(
      env as any, testDomain, testEmail, testContext,
      'cold-outreach-step1', 'test-campaign'
    );

    // Should have recorded the email attempt
    const emailInsert = env.DB._queries.find(q =>
      q.sql.includes('INSERT INTO channel_attempts') && q.params.includes('email')
    );
    expect(emailInsert).toBeDefined();
    expect(used).toEqual([]);
  });

  it('stages eligible Skrip channels into the outbox when authority is enabled', async () => {
    env = createMockEnv({
      ENVIRONMENT: 'production' as any,
      SKRIP_DEFAULT_ENABLEMENT: 'true',
    });

    env.DB.onQuery(/FROM contact_channel_identities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        external_contact_id: testEmail,
        canonical_id: 'skrip_can_1',
        channel: 'push',
        consent_state: 'opted_in',
        suppression_state: 'clear',
        availability_state: 'available',
        identity_confidence: 1,
        registration_state: 'registered',
        last_reconciled_at: null,
        created_at: 1,
        updated_at: 1,
      },
    ]);
    env.DB.onQuery(/FROM channel_authorities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        campaign_id: 'test-campaign',
        channel: 'push',
        authority: 'skrip',
        rollout_state: 'dry_run',
        feature_flag_key: null,
        created_at: 1,
        updated_at: 1,
      },
    ]);

    const used = await executeSecondaryChannels(
      env as any, testDomain, testEmail, testContext,
      'cold-outreach-step1', 'test-campaign'
    );

    const outboxInsert = env.DB._queries.find(q =>
      q.sql.includes('INSERT OR IGNORE INTO channel_execution_outbox') &&
      q.params.includes('push') &&
      q.params.includes('dry_run')
    );
    const fallbackTelemetryCounter = env.DB._queries.find(q =>
      q.sql.includes('INSERT INTO telemetry_channel_daily') &&
      q.params.includes('system')
    );

    expect(used).toEqual([]);
    expect(outboxInsert).toBeDefined();
    expect(fallbackTelemetryCounter).toBeDefined();
  });

  it('resolves campaign fallback target from email to push before whatsapp', async () => {
    env = createMockEnv({
      ENVIRONMENT: 'production' as any,
      SKRIP_DEFAULT_ENABLEMENT: 'true',
    });

    env.DB.onQuery(/FROM contact_channel_identities/i, () => [
      {
        id: 1,
        tenant_id: 'default',
        external_contact_id: testEmail,
        canonical_id: 'skrip_can_push',
        channel: 'push',
        consent_state: 'opted_in',
        suppression_state: 'clear',
        availability_state: 'available',
        identity_confidence: 1,
        registration_state: 'registered',
        last_reconciled_at: null,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 2,
        tenant_id: 'default',
        external_contact_id: testEmail,
        canonical_id: 'skrip_can_whatsapp',
        channel: 'whatsapp',
        consent_state: 'opted_in',
        suppression_state: 'clear',
        availability_state: 'available',
        identity_confidence: 1,
        registration_state: 'registered',
        last_reconciled_at: null,
        created_at: 1,
        updated_at: 1,
      },
    ]);

    env.DB.onQuery(/FROM channel_authorities/i, (params) => [{
      id: 1,
      tenant_id: 'default',
      campaign_id: 'test-campaign',
      channel: String(params?.[1] ?? 'push'),
      authority: 'skrip',
      rollout_state: 'dry_run',
      feature_flag_key: null,
      created_at: 1,
      updated_at: 1,
    }]);

    await executeSecondaryChannels(
      env as any,
      testDomain,
      testEmail,
      testContext,
      'cold-outreach-step1',
      'test-campaign',
      {
        allowedSkripChannels: ['push', 'whatsapp'],
        fallbackChain: ['email', 'push', 'whatsapp'],
      },
    );

    const fallbackQueueEntry = env.DB._queries.find((query) =>
      query.sql.includes('INSERT INTO telemetry_fallback_queue')
      && query.params.some((param) => typeof param === 'string' && param.includes('outbound.channel_fallback'))
      && query.params.some((param) => typeof param === 'string' && param.includes('"toChannel":"push"')),
    );

    expect(fallbackQueueEntry).toBeDefined();
  });

  it('attempts contact form on step1 when channel exists and no prior attempt', async () => {
    // Register handler: prospect_channels SELECT returns a form
    env.DB.onQuery(/SELECT[\s\S]*prospect_channels[\s\S]*contact_form/, () => [
      { channel_value: testForm.action, channel_meta: JSON.stringify(testForm) },
    ]);

    // Register handler: channel_attempts SELECT returns no prior attempt
    env.DB.onQuery(/SELECT[\s\S]*channel_attempts[\s\S]*contact_form/, () => []);

    // Form submission succeeds
    mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));

    const used = await executeSecondaryChannels(
      env as any, testDomain, testEmail, testContext,
      'cold-outreach-step1', 'test-campaign'
    );

    expect(used).toContain('contact_form');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('skips contact form on step2+', async () => {
    env.DB.onQuery(/SELECT[\s\S]*prospect_channels[\s\S]*contact_form/, () => [
      { channel_value: testForm.action, channel_meta: JSON.stringify(testForm) },
    ]);

    const used = await executeSecondaryChannels(
      env as any, testDomain, testEmail, testContext,
      'cold-outreach-step2', 'test-campaign'
    );

    expect(used).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips contact form when prior attempt exists', async () => {
    env.DB.onQuery(/SELECT[\s\S]*prospect_channels[\s\S]*contact_form/, () => [
      { channel_value: testForm.action, channel_meta: JSON.stringify(testForm) },
    ]);

    // Prior attempt exists
    env.DB.onQuery(/SELECT[\s\S]*channel_attempts[\s\S]*contact_form/, () => [{ id: 1 }]);

    const used = await executeSecondaryChannels(
      env as any, testDomain, testEmail, testContext,
      'cold-outreach-step1', 'test-campaign'
    );

    expect(used).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('records failed attempt when form submission fails', async () => {
    env.DB.onQuery(/SELECT[\s\S]*prospect_channels[\s\S]*contact_form/, () => [
      { channel_value: testForm.action, channel_meta: JSON.stringify(testForm) },
    ]);
    env.DB.onQuery(/SELECT[\s\S]*channel_attempts[\s\S]*contact_form/, () => []);

    // Form submission returns error
    mockFetch.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));

    const used = await executeSecondaryChannels(
      env as any, testDomain, testEmail, testContext,
      'cold-outreach-step1', 'test-campaign'
    );

    expect(used).toEqual([]);
    // Should have recorded a 'failed' attempt
    const failedInsert = env.DB._queries.find(q =>
      q.sql.includes('INSERT INTO channel_attempts') && q.params.includes('failed') && q.params.includes('contact_form')
    );
    expect(failedInsert).toBeDefined();
  });

  it('handles form submission exception gracefully', async () => {
    env.DB.onQuery(/SELECT[\s\S]*prospect_channels[\s\S]*contact_form/, () => [
      { channel_value: testForm.action, channel_meta: JSON.stringify(testForm) },
    ]);
    env.DB.onQuery(/SELECT[\s\S]*channel_attempts[\s\S]*contact_form/, () => []);

    // Network error — submitContactForm catches internally and returns false
    mockFetch.mockRejectedValueOnce(new Error('network timeout'));

    const used = await executeSecondaryChannels(
      env as any, testDomain, testEmail, testContext,
      'cold-outreach-step1', 'test-campaign'
    );

    expect(used).toEqual([]);
    // submitContactForm swallows the error and returns false,
    // so orchestrator records a 'failed' attempt (without error detail)
    const failedInsert = env.DB._queries.find(q =>
      q.sql.includes('INSERT INTO channel_attempts') &&
      q.params.includes('failed') &&
      q.params.includes('contact_form')
    );
    expect(failedInsert).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// executeWithoutEmail()
// ─────────────────────────────────────────────────────────────────────────

describe('executeWithoutEmail()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv({ ENVIRONMENT: 'production' as any });
  });

  it('attempts contact form when available and no prior attempt', async () => {
    env.DB.onQuery(/SELECT[\s\S]*prospect_channels[\s\S]*contact_form/, () => [
      { channel_value: testForm.action, channel_meta: JSON.stringify(testForm) },
    ]);
    env.DB.onQuery(/SELECT[\s\S]*channel_attempts[\s\S]*contact_form/, () => []);
    // Return empty for manual channels query
    env.DB.onQuery(/SELECT[\s\S]*prospect_channels[\s\S]*NOT IN/, () => []);

    mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));

    const result = await executeWithoutEmail(
      env as any, testDomain, testContext, 'test-campaign'
    );

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('skips form when prior attempt exists', async () => {
    env.DB.onQuery(/SELECT[\s\S]*prospect_channels[\s\S]*contact_form/, () => [
      { channel_value: testForm.action, channel_meta: JSON.stringify(testForm) },
    ]);
    env.DB.onQuery(/SELECT[\s\S]*channel_attempts[\s\S]*contact_form/, () => [{ id: 1 }]);
    env.DB.onQuery(/SELECT[\s\S]*prospect_channels[\s\S]*NOT IN/, () => []);

    const result = await executeWithoutEmail(
      env as any, testDomain, testContext, 'test-campaign'
    );

    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns false when no channels exist', async () => {
    const result = await executeWithoutEmail(
      env as any, testDomain, testContext, 'test-campaign'
    );

    expect(result).toBe(false);
  });

  it('logs manual channels when only social/chat available', async () => {
    // No form — use a specific pattern that won't match the NOT IN query
    env.DB.onQuery(/SELECT channel_value, channel_meta FROM prospect_channels/, () => []);

    // Manual channels available — match the NOT IN query specifically
    env.DB.onQuery(/channel_type NOT IN/, () => [
      { channel_type: 'twitter', channel_value: 'https://twitter.com/acme' },
      { channel_type: 'linkedin', channel_value: 'https://linkedin.com/company/acme' },
    ]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await executeWithoutEmail(
      env as any, testDomain, testContext, 'test-campaign'
    );

    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('2 manual channels available')
    );
    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// getProspectChannels() — admin query
// ─────────────────────────────────────────────────────────────────────────

describe('getProspectChannels()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('returns channels with attempt counts for a domain', async () => {
    env.DB.onQuery(/SELECT[\s\S]*prospect_channels[\s\S]*LEFT JOIN/, () => [
      { channel_type: 'email', channel_value: testEmail, priority: 1, detected_at: 1706400000, attempts: 3, last_status: 'delivered' },
      { channel_type: 'contact_form', channel_value: testForm.action, priority: 2, detected_at: 1706400000, attempts: 1, last_status: 'delivered' },
      { channel_type: 'twitter', channel_value: 'https://twitter.com/acme', priority: 3, detected_at: 1706400000, attempts: 0, last_status: null },
    ]);

    const channels = await getProspectChannels(env as any, testDomain);

    expect(channels).toHaveLength(3);
    expect(channels[0].channel_type).toBe('email');
    expect(channels[0].attempts).toBe(3);
    expect(channels[2].attempts).toBe(0);
    expect(channels[2].last_status).toBeNull();
  });

  it('returns empty array for unknown domain', async () => {
    const channels = await getProspectChannels(env as any, 'nonexistent.com');
    expect(channels).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// getChannelStats() — admin aggregate query
// ─────────────────────────────────────────────────────────────────────────

describe('getChannelStats()', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('returns aggregate stats across all prospects', async () => {
    // Channel counts
    env.DB.onQuery(/SELECT[\s\S]*channel_type[\s\S]*COUNT[\s\S]*FROM prospect_channels[\s\S]*GROUP BY/, () => [
      { channel_type: 'email', count: 50 },
      { channel_type: 'contact_form', count: 30 },
      { channel_type: 'twitter', count: 15 },
    ]);

    // Attempt counts
    env.DB.onQuery(/SELECT[\s\S]*channel_type[\s\S]*status[\s\S]*COUNT[\s\S]*FROM channel_attempts[\s\S]*GROUP BY/, () => [
      { channel_type: 'email', status: 'delivered', count: 45 },
      { channel_type: 'email', status: 'failed', count: 5 },
      { channel_type: 'contact_form', status: 'delivered', count: 20 },
      { channel_type: 'contact_form', status: 'failed', count: 10 },
    ]);

    // Total prospects
    env.DB.onQuery(/SELECT[\s\S]*COUNT[\s\S]*DISTINCT[\s\S]*FROM prospect_channels/, () => [
      { count: 60 },
    ]);

    const stats = await getChannelStats(env as any);

    expect(stats.totalProspects).toBe(60);
    expect(stats.channelCounts.email).toBe(50);
    expect(stats.channelCounts.contact_form).toBe(30);
    expect(stats.attemptCounts.email.delivered).toBe(45);
    expect(stats.attemptCounts.email.failed).toBe(5);
    expect(stats.attemptCounts.contact_form.delivered).toBe(20);
    expect(stats.prospectsWith.twitter).toBe(15);
  });

  it('returns zeroes when no data exists', async () => {
    const stats = await getChannelStats(env as any);

    expect(stats.totalProspects).toBe(0);
    expect(stats.channelCounts).toEqual({});
    expect(stats.attemptCounts).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CHANNEL_PRIORITY
// ─────────────────────────────────────────────────────────────────────────

describe('CHANNEL_PRIORITY', () => {
  it('has email as highest priority (1)', () => {
    expect(CHANNEL_PRIORITY.email).toBe(1);
  });

  it('has contact_form as second priority (2)', () => {
    expect(CHANNEL_PRIORITY.contact_form).toBe(2);
  });

  it('has social channels before chat channels', () => {
    expect(CHANNEL_PRIORITY.twitter).toBeLessThan(CHANNEL_PRIORITY.chat_intercom);
    expect(CHANNEL_PRIORITY.linkedin).toBeLessThan(CHANNEL_PRIORITY.chat_drift);
  });

  it('covers all expected channel types', () => {
    const expected = [
      'email', 'contact_form',
      'twitter', 'linkedin', 'facebook', 'github', 'instagram',
      'chat_intercom', 'chat_drift', 'chat_crisp', 'chat_hubspot',
    ];
    for (const type of expected) {
      expect(CHANNEL_PRIORITY).toHaveProperty(type);
    }
  });
});
