import type { Env } from '../types';
import { SKRIP_CONFIG } from '../constants';
import { execute, now, queryOne } from '../lib/db';
import { badRequest, ok } from '../lib/response';
import { getCorrelationId } from '../lib/correlation';

type PushReceiptType = 'delivered' | 'clicked' | 'dismissed';

interface PushReceiptBody {
  notificationId?: unknown;
  type?: unknown;
  timestamp?: unknown;
  tenantId?: unknown;
  contactId?: unknown;
  campaignId?: unknown;
  stepId?: unknown;
  source?: unknown;
  receiptId?: unknown;
  metadata?: unknown;
}

interface PushStatusRow {
  notification_id: string;
  sent_at: number | null;
  delivered_at: number | null;
  clicked_at: number | null;
  dismissed_at: number | null;
  channel: string;
  contact_id: string | null;
  campaign_id: string | null;
  step_id: string | null;
  updated_at: number;
}

interface LineageStatusRow {
  message_id: string;
  latest_status: string;
  first_sent_at: number | null;
  last_outcome_at: number | null;
}

const ALLOWED_RECEIPT_TYPES: PushReceiptType[] = ['delivered', 'clicked', 'dismissed'];

function parseOccurredAt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const asNum = Number.parseInt(value, 10);
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum;
    }
    const asIso = Date.parse(value);
    if (Number.isFinite(asIso)) {
      return Math.floor(asIso / 1000);
    }
  }
  return now();
}

function parseReceiptType(value: unknown): PushReceiptType | null {
  if (typeof value !== 'string') return null;
  return ALLOWED_RECEIPT_TYPES.includes(value as PushReceiptType)
    ? (value as PushReceiptType)
    : null;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function handlePushReceipt(request: Request, env: Env): Promise<Response> {
  let body: PushReceiptBody;
  try {
    body = (await request.json()) as PushReceiptBody;
  } catch {
    return badRequest('Invalid JSON body');
  }

  const notificationId = normalizeOptionalString(body.notificationId);
  const receiptType = parseReceiptType(body.type);
  if (!notificationId) {
    return badRequest('notificationId is required');
  }
  if (!receiptType) {
    return badRequest("type must be one of: 'delivered', 'clicked', 'dismissed'");
  }

  const occurredAt = parseOccurredAt(body.timestamp);
  const tenantId = normalizeOptionalString(body.tenantId) ?? SKRIP_CONFIG.DEFAULT_TENANT_ID;
  const contactId = normalizeOptionalString(body.contactId);
  const campaignId = normalizeOptionalString(body.campaignId);
  const stepId = normalizeOptionalString(body.stepId);
  const source = normalizeOptionalString(body.source) ?? 'service_worker';
  const receiptId = normalizeOptionalString(body.receiptId);
  const epoch = now();

  const deliveredAt = receiptType === 'delivered' || receiptType === 'clicked' ? occurredAt : null;
  const clickedAt = receiptType === 'clicked' ? occurredAt : null;
  const dismissedAt = receiptType === 'dismissed' ? occurredAt : null;

  await execute(
    env.DB,
    `INSERT INTO push_notifications
      (notification_id, tenant_id, contact_id, campaign_id, step_id, channel, sent_at, delivered_at, clicked_at, dismissed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'push', NULL, ?, ?, ?, ?, ?)
     ON CONFLICT(notification_id) DO UPDATE SET
       tenant_id = COALESCE(push_notifications.tenant_id, excluded.tenant_id),
       contact_id = COALESCE(push_notifications.contact_id, excluded.contact_id),
       campaign_id = COALESCE(push_notifications.campaign_id, excluded.campaign_id),
       step_id = COALESCE(push_notifications.step_id, excluded.step_id),
       delivered_at = CASE
         WHEN excluded.delivered_at IS NULL THEN push_notifications.delivered_at
         WHEN push_notifications.delivered_at IS NULL THEN excluded.delivered_at
         ELSE MIN(push_notifications.delivered_at, excluded.delivered_at)
       END,
       clicked_at = CASE
         WHEN excluded.clicked_at IS NULL THEN push_notifications.clicked_at
         WHEN push_notifications.clicked_at IS NULL THEN excluded.clicked_at
         ELSE MIN(push_notifications.clicked_at, excluded.clicked_at)
       END,
       dismissed_at = CASE
         WHEN excluded.dismissed_at IS NULL THEN push_notifications.dismissed_at
         WHEN push_notifications.dismissed_at IS NULL THEN excluded.dismissed_at
         ELSE MIN(push_notifications.dismissed_at, excluded.dismissed_at)
       END,
       updated_at = excluded.updated_at`,
    [
      notificationId,
      tenantId,
      contactId,
      campaignId,
      stepId,
      deliveredAt,
      clickedAt,
      dismissedAt,
      epoch,
      epoch,
    ],
  );

  await execute(
    env.DB,
    `INSERT OR IGNORE INTO push_notification_receipt_events
      (notification_id, receipt_type, occurred_at, source, correlation_id, receipt_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      notificationId,
      receiptType,
      occurredAt,
      source,
      getCorrelationId(),
      receiptId,
      body.metadata ? JSON.stringify(body.metadata) : null,
      epoch,
    ],
  );

  const lineageStatus = receiptType === 'clicked'
    ? 'message.clicked'
    : receiptType === 'delivered'
      ? 'message.delivered'
      : 'message.dismissed';

  await execute(
    env.DB,
    `UPDATE channel_message_lineage
        SET latest_status = ?,
            last_outcome_at = ?,
            updated_at = ?
      WHERE message_id = ?`,
    [lineageStatus, occurredAt, epoch, notificationId],
  );

  return ok({
    accepted: true,
    notificationId,
    type: receiptType,
    occurredAt,
  });
}

export async function handlePushStatus(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  const prefix = '/api/push/status/';
  if (!path.startsWith(prefix) || path.length <= prefix.length) {
    return badRequest('Missing notificationId in path');
  }

  const notificationId = decodeURIComponent(path.slice(prefix.length));
  if (!notificationId) {
    return badRequest('notificationId is required');
  }

  const row = await queryOne<PushStatusRow>(
    env.DB,
    `SELECT notification_id, sent_at, delivered_at, clicked_at, dismissed_at, channel, contact_id, campaign_id, step_id, updated_at
       FROM push_notifications
      WHERE notification_id = ?
      LIMIT 1`,
    [notificationId],
  );

  if (row) {
    return ok({
      notificationId,
      sent: row.sent_at !== null,
      delivered: row.delivered_at !== null,
      clicked: row.clicked_at !== null,
      dismissed: row.dismissed_at !== null,
      timestamps: {
        sentAt: row.sent_at,
        deliveredAt: row.delivered_at,
        clickedAt: row.clicked_at,
        dismissedAt: row.dismissed_at,
        updatedAt: row.updated_at,
      },
      context: {
        channel: row.channel,
        contactId: row.contact_id,
        campaignId: row.campaign_id,
        stepId: row.step_id,
      },
    });
  }

  const lineage = await queryOne<LineageStatusRow>(
    env.DB,
    `SELECT message_id, latest_status, first_sent_at, last_outcome_at
       FROM channel_message_lineage
      WHERE message_id = ?
      LIMIT 1`,
    [notificationId],
  );

  if (!lineage) {
    return ok({
      notificationId,
      sent: false,
      delivered: false,
      clicked: false,
      dismissed: false,
      timestamps: {
        sentAt: null,
        deliveredAt: null,
        clickedAt: null,
        dismissedAt: null,
        updatedAt: null,
      },
    });
  }

  const latest = lineage.latest_status ?? '';
  const delivered = latest.includes('delivered') || latest.includes('clicked');
  const clicked = latest.includes('clicked');
  const dismissed = latest.includes('dismissed');

  return ok({
    notificationId,
    sent: lineage.first_sent_at !== null,
    delivered,
    clicked,
    dismissed,
    timestamps: {
      sentAt: lineage.first_sent_at,
      deliveredAt: delivered ? lineage.last_outcome_at : null,
      clickedAt: clicked ? lineage.last_outcome_at : null,
      dismissedAt: dismissed ? lineage.last_outcome_at : null,
      updatedAt: lineage.last_outcome_at,
    },
    source: 'lineage_fallback',
  });
}
