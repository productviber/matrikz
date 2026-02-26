/**
 * Notifications Tests
 *
 * Tests for Slack, Discord, and pre-built notification messages.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  sendSlackNotification,
  sendDiscordNotification,
  notifyNewConversion,
  notifyAffiliateConversion,
  notifyTierUpgrade,
  notifyEarningsMilestone,
  notifyPayoutCompleted,
} from '../../src/lib/notifications';
import { createMockEnv, type MockEnv } from '../helpers';

describe('notifications', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
    vi.restoreAllMocks();
  });

  describe('sendSlackNotification()', () => {
    it('returns false when SLACK_WEBHOOK_URL is empty', async () => {
      env.SLACK_WEBHOOK_URL = '';
      const result = await sendSlackNotification(env as any, 'test message');
      expect(result).toBe(false);
    });

    it('sends to Slack and returns true on success', async () => {
      env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('ok', { status: 200 })
      );

      const result = await sendSlackNotification(env as any, 'test message');
      expect(result).toBe(true);
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy.mock.calls[0][0]).toBe('https://hooks.slack.com/test');
    });

    it('includes blocks when provided', async () => {
      env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('ok', { status: 200 })
      );

      const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'test' } }];
      await sendSlackNotification(env as any, 'test', blocks);

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.blocks).toEqual(blocks);
    });

    it('returns false on fetch error', async () => {
      env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

      const result = await sendSlackNotification(env as any, 'test');
      expect(result).toBe(false);
    });

    it('returns false on non-ok response', async () => {
      env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('error', { status: 500 })
      );

      const result = await sendSlackNotification(env as any, 'test');
      expect(result).toBe(false);
    });
  });

  describe('sendDiscordNotification()', () => {
    it('returns false when DISCORD_WEBHOOK_URL is empty', async () => {
      env.DISCORD_WEBHOOK_URL = '';
      const result = await sendDiscordNotification(env as any, 'test message');
      expect(result).toBe(false);
    });

    it('sends to Discord and returns true on success', async () => {
      env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('ok', { status: 200 })
      );

      const result = await sendDiscordNotification(env as any, 'test message');
      expect(result).toBe(true);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('includes embeds when provided', async () => {
      env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('ok', { status: 200 })
      );

      const embeds = [{ title: 'Test', description: 'test embed' }];
      await sendDiscordNotification(env as any, 'test', embeds);

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.embeds).toEqual(embeds);
    });

    it('returns false on fetch error', async () => {
      env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

      const result = await sendDiscordNotification(env as any, 'test');
      expect(result).toBe(false);
    });
  });

  describe('notifyNewConversion()', () => {
    it('sends to both Slack and Discord (disabled = no error)', async () => {
      // Both URLs empty — should not throw
      await expect(
        notifyNewConversion(env as any, {
          userId: 'user-123',
          plan: 'pro',
          amountCents: 2900,
          gateway: 'stripe',
        })
      ).resolves.not.toThrow();
    });

    it('sends notification with conversion details', async () => {
      env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
      env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 })
      );

      await notifyNewConversion(env as any, {
        userId: 'u@test.com',
        plan: 'pro',
        amountCents: 2900,
        gateway: 'stripe',
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const slackBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(slackBody.text).toContain('Conversion');
      expect(slackBody.text).toContain('pro');
      expect(slackBody.text).toContain('$29.00');
    });
  });

  describe('notifyAffiliateConversion()', () => {
    it('includes affiliate code and commission in message', async () => {
      env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 })
      );

      await notifyAffiliateConversion(env as any, {
        affiliateCode: 'aff-jane',
        plan: 'yearly',
        amountCents: 14900,
        commissionCents: 2980,
      });

      const slackBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(slackBody.text).toContain('aff-jane');
      expect(slackBody.text).toContain('$29.80');
    });
  });

  describe('notifyTierUpgrade()', () => {
    it('sends tier upgrade message', async () => {
      env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 })
      );

      await notifyTierUpgrade(env as any, 'aff-123', 'Gold', 0.30);

      const slackBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(slackBody.text).toContain('Tier Upgrade');
      expect(slackBody.text).toContain('Gold');
      expect(slackBody.text).toContain('30%');
    });
  });

  describe('notifyEarningsMilestone()', () => {
    it('sends milestone message', async () => {
      env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 })
      );

      await notifyEarningsMilestone(env as any, 'aff-123', 100000);

      const slackBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(slackBody.text).toContain('Milestone');
      expect(slackBody.text).toContain('$1000.00');
    });
  });

  describe('notifyPayoutCompleted()', () => {
    it('sends payout completed message', async () => {
      env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 })
      );

      await notifyPayoutCompleted(env as any, 42, 500000, 5);

      const slackBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(slackBody.text).toContain('Payout Batch Completed');
      expect(slackBody.text).toContain('#42');
      expect(slackBody.text).toContain('$5000.00');
      expect(slackBody.text).toContain('5');
    });
  });
});
