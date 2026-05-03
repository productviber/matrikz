import { beforeEach, describe, expect, it } from 'vitest';
import { handlePushReceipt, handlePushStatus } from '../../src/routes/push-receipts';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';

type PushNotificationState = {
  notification_id: string;
  tenant_id: string;
  contact_id: string | null;
  campaign_id: string | null;
  step_id: string | null;
  channel: string;
  sent_at: number | null;
  delivered_at: number | null;
  clicked_at: number | null;
  dismissed_at: number | null;
  created_at: number;
  updated_at: number;
};

describe('push receipt + status routes', () => {
  let env: MockEnv;
  let notifications: Map<string, PushNotificationState>;
  let receiptEvents: Array<{ notification_id: string; receipt_type: string; receipt_id: string | null }>;

  beforeEach(() => {
    env = createMockEnv();
    notifications = new Map<string, PushNotificationState>();
    receiptEvents = [];

    env.DB.onQuery(/INSERT INTO push_notifications/i, (params) => {
      const [
        notificationId,
        tenantId,
        contactId,
        campaignId,
        stepId,
        deliveredAt,
        clickedAt,
        dismissedAt,
        createdAt,
        updatedAt,
      ] = params;

      const id = String(notificationId);
      const existing = notifications.get(id);
      if (!existing) {
        notifications.set(id, {
          notification_id: id,
          tenant_id: String(tenantId),
          contact_id: contactId ? String(contactId) : null,
          campaign_id: campaignId ? String(campaignId) : null,
          step_id: stepId ? String(stepId) : null,
          channel: 'push',
          sent_at: null,
          delivered_at: deliveredAt == null ? null : Number(deliveredAt),
          clicked_at: clickedAt == null ? null : Number(clickedAt),
          dismissed_at: dismissedAt == null ? null : Number(dismissedAt),
          created_at: Number(createdAt),
          updated_at: Number(updatedAt),
        });
        return [];
      }

      const nextDelivered = deliveredAt == null ? null : Number(deliveredAt);
      const nextClicked = clickedAt == null ? null : Number(clickedAt);
      const nextDismissed = dismissedAt == null ? null : Number(dismissedAt);

      existing.delivered_at = nextDelivered == null
        ? existing.delivered_at
        : existing.delivered_at == null
          ? nextDelivered
          : Math.min(existing.delivered_at, nextDelivered);
      existing.clicked_at = nextClicked == null
        ? existing.clicked_at
        : existing.clicked_at == null
          ? nextClicked
          : Math.min(existing.clicked_at, nextClicked);
      existing.dismissed_at = nextDismissed == null
        ? existing.dismissed_at
        : existing.dismissed_at == null
          ? nextDismissed
          : Math.min(existing.dismissed_at, nextDismissed);
      existing.updated_at = Number(updatedAt);
      return [];
    });

    env.DB.onQuery(/INSERT OR IGNORE INTO push_notification_receipt_events/i, (params) => {
      receiptEvents.push({
        notification_id: String(params[0]),
        receipt_type: String(params[1]),
        receipt_id: params[5] == null ? null : String(params[5]),
      });
      return [];
    });

    env.DB.onQuery(/UPDATE channel_message_lineage/i, () => []);

    env.DB.onQuery(/FROM push_notifications\s+WHERE notification_id = \?/i, (params) => {
      const row = notifications.get(String(params[0]));
      return row ? [row] : [];
    });

    env.DB.onQuery(/FROM channel_message_lineage\s+WHERE message_id = \?/i, (params) => {
      if (String(params[0]) === 'lineage_only_1') {
        return [{
          message_id: 'lineage_only_1',
          latest_status: 'message.delivered',
          first_sent_at: 1711111111,
          last_outcome_at: 1711111122,
        }];
      }
      return [];
    });
  });

  it('accepts delivered receipt and exposes delivered=true in status', async () => {
    const receiptReq = makeRequest('POST', '/api/push/receipt', {
      notificationId: 'notif_1',
      type: 'delivered',
      timestamp: 1712222222,
      tenantId: 'default',
      contactId: 'user@acme.com',
      campaignId: 'cmp_1',
      stepId: 'step_1',
      receiptId: 'rcpt_1',
    });

    const receiptRes = await handlePushReceipt(receiptReq, env as any);
    expect(receiptRes.status).toBe(200);

    const statusReq = new Request('https://test.workers.dev/api/push/status/notif_1');
    const statusRes = await handlePushStatus(statusReq, env as any);
    expect(statusRes.status).toBe(200);

    const statusBody = await statusRes.json() as { data: { sent: boolean; delivered: boolean; clicked: boolean } };
    expect(statusBody.data.sent).toBe(false);
    expect(statusBody.data.delivered).toBe(true);
    expect(statusBody.data.clicked).toBe(false);
    expect(receiptEvents).toHaveLength(1);
  });

  it('treats clicked receipt as delivered+clicked and is idempotent on timestamps', async () => {
    const first = makeRequest('POST', '/api/push/receipt', {
      notificationId: 'notif_2',
      type: 'clicked',
      timestamp: 1713000000,
    });
    const second = makeRequest('POST', '/api/push/receipt', {
      notificationId: 'notif_2',
      type: 'clicked',
      timestamp: 1713001234,
    });

    await handlePushReceipt(first, env as any);
    await handlePushReceipt(second, env as any);

    const statusReq = new Request('https://test.workers.dev/api/push/status/notif_2');
    const statusRes = await handlePushStatus(statusReq, env as any);
    const statusBody = await statusRes.json() as {
      data: {
        delivered: boolean;
        clicked: boolean;
        timestamps: { deliveredAt: number | null; clickedAt: number | null };
      };
    };

    expect(statusBody.data.delivered).toBe(true);
    expect(statusBody.data.clicked).toBe(true);
    expect(statusBody.data.timestamps.deliveredAt).toBe(1713000000);
    expect(statusBody.data.timestamps.clickedAt).toBe(1713000000);
  });

  it('returns 400 for invalid receipt type', async () => {
    const req = makeRequest('POST', '/api/push/receipt', {
      notificationId: 'notif_bad',
      type: 'opened',
    });

    const res = await handlePushReceipt(req, env as any);
    expect(res.status).toBe(400);
  });

  it('falls back to lineage when notification snapshot row is absent', async () => {
    const req = new Request('https://test.workers.dev/api/push/status/lineage_only_1');
    const res = await handlePushStatus(req, env as any);
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { sent: boolean; delivered: boolean; clicked: boolean; source: string } };
    expect(body.data.sent).toBe(true);
    expect(body.data.delivered).toBe(true);
    expect(body.data.clicked).toBe(false);
    expect(body.data.source).toBe('lineage_fallback');
  });

  it('returns all-false status for unknown notificationId', async () => {
    const req = new Request('https://test.workers.dev/api/push/status/unknown_1');
    const res = await handlePushStatus(req, env as any);
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { sent: boolean; delivered: boolean; clicked: boolean; dismissed: boolean } };
    expect(body.data.sent).toBe(false);
    expect(body.data.delivered).toBe(false);
    expect(body.data.clicked).toBe(false);
    expect(body.data.dismissed).toBe(false);
  });
});
