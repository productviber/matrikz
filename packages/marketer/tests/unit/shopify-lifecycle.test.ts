import { describe, expect, it } from 'vitest';
import { handleAppUninstalled } from '../../src/events/shopify-lifecycle';
import { createMockEnv } from '../helpers';

describe('Shopify lifecycle handlers', () => {
  it('deactivates available push identity rows when the app is uninstalled', async () => {
    const env = createMockEnv();
    env.DB.onQuery(/UPDATE contact_channel_identities/i, () => []);
    env.DB.onQuery(/INSERT INTO agent_action_outcomes/i, () => []);

    await handleAppUninstalled(env as any, {
      shop: 'store.example.com',
      email: 'lead@example.com',
    }, '2026-05-03T00:00:00.000Z');

    expect(env.DB._queries.some((query) => /UPDATE contact_channel_identities/i.test(query.sql))).toBe(true);
  });
});
