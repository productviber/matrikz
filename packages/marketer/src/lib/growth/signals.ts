import type { Env, GrowthSignalRow, GrowthSignalSeverity, GrowthSubjectType } from '../../types';
import {
  EVENT_TYPES,
  GROWTH_POLICY,
  GROWTH_SIGNAL_SEVERITY,
  GROWTH_SIGNAL_STATUS,
  GROWTH_SIGNAL_TYPE,
  GROWTH_SUBJECT_TYPE,
} from '../../constants';
import { execute, now, query, queryOne } from '../db';
import {
  clampInteger,
  hashObject,
  isRecord,
  isoToEpochSeconds,
  normalizeSubjectId,
  normalizeTenantId,
  parseJsonObject,
} from './common';

export interface GrowthSignalInput {
  tenantId?: string | null;
  subjectType: GrowthSubjectType | string;
  subjectId: string;
  signalType: string;
  severity?: GrowthSignalSeverity | string;
  confidence?: number;
  detectedAt?: number;
  expiresAt?: number;
  sourceEventId?: string | null;
  evidence?: Record<string, unknown>;
}

export interface GrowthSignalView extends Omit<GrowthSignalRow, 'evidence_json'> {
  evidence: Record<string, unknown>;
}

export interface GrowthSignalListFilters {
  tenantId?: string | null;
  status?: string;
  subjectId?: string;
  subjectType?: string;
  signalType?: string;
  severity?: string;
  includeExpired?: boolean;
  limit?: number;
}

const SEVERITY_RANK: Record<string, number> = {
  [GROWTH_SIGNAL_SEVERITY.CRITICAL]: 4,
  [GROWTH_SIGNAL_SEVERITY.HIGH]: 3,
  [GROWTH_SIGNAL_SEVERITY.MEDIUM]: 2,
  [GROWTH_SIGNAL_SEVERITY.LOW]: 1,
};

function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? SEVERITY_RANK[GROWTH_SIGNAL_SEVERITY.MEDIUM];
}

function signalTtlSeconds(signalType: string, severity: string): number {
  const highIntent = severity === GROWTH_SIGNAL_SEVERITY.HIGH || severity === GROWTH_SIGNAL_SEVERITY.CRITICAL;
  const days = highIntent || signalType === GROWTH_SIGNAL_TYPE.AUDIT_GRADE_LOW_HIGH_FIT
    ? GROWTH_POLICY.HIGH_INTENT_SIGNAL_TTL_DAYS
    : GROWTH_POLICY.DEFAULT_SIGNAL_TTL_DAYS;
  return days * 24 * 60 * 60;
}

async function buildSignalId(input: {
  tenantId: string;
  subjectType: string;
  subjectId: string;
  signalType: string;
  detectedAt: number;
}): Promise<string> {
  const windowSeconds = GROWTH_POLICY.ACTION_WINDOW_SECONDS;
  const actionWindow = Math.floor(input.detectedAt / windowSeconds);
  const hash = await hashObject({
    tenantId: input.tenantId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    signalType: input.signalType,
    actionWindow,
  });
  return `sig_${hash}`;
}

function asSignalView(row: GrowthSignalRow): GrowthSignalView {
  const { evidence_json: evidenceJson, ...rest } = row;
  return { ...rest, evidence: parseJsonObject(evidenceJson) };
}

export async function upsertGrowthSignal(env: Env, input: GrowthSignalInput): Promise<GrowthSignalView> {
  const tenantId = normalizeTenantId(input.tenantId);
  const subjectType = input.subjectType.trim().toLowerCase();
  const subjectId = normalizeSubjectId(input.subjectId);
  const detectedAt = input.detectedAt ?? now();
  const severity = input.severity ?? GROWTH_SIGNAL_SEVERITY.MEDIUM;
  const confidence = clampInteger(input.confidence ?? GROWTH_POLICY.DEFAULT_CONFIDENCE, 0, 100);
  const expiresAt = input.expiresAt ?? detectedAt + signalTtlSeconds(input.signalType, severity);
  const signalId = await buildSignalId({ tenantId, subjectType, subjectId, signalType: input.signalType, detectedAt });
  const epoch = now();
  const evidenceJson = JSON.stringify({
    severityRank: severityRank(severity),
    ...(input.evidence ?? {}),
  });

  await execute(
    env.DB,
    `INSERT INTO growth_signals
      (signal_id, tenant_id, subject_type, subject_id, signal_type, severity, confidence, detected_at, expires_at, source_event_id, evidence_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(signal_id) DO UPDATE SET
       severity = excluded.severity,
       confidence = MAX(growth_signals.confidence, excluded.confidence),
       expires_at = MAX(growth_signals.expires_at, excluded.expires_at),
       source_event_id = COALESCE(excluded.source_event_id, growth_signals.source_event_id),
       evidence_json = excluded.evidence_json,
       status = CASE
         WHEN growth_signals.status = 'expired' THEN 'active'
         WHEN growth_signals.status = 'dismissed' THEN growth_signals.status
         ELSE excluded.status
       END,
       updated_at = excluded.updated_at`,
    [
      signalId,
      tenantId,
      subjectType,
      subjectId,
      input.signalType,
      severity,
      confidence,
      detectedAt,
      expiresAt,
      input.sourceEventId ?? null,
      evidenceJson,
      GROWTH_SIGNAL_STATUS.ACTIVE,
      epoch,
      epoch,
    ],
  );

  const row = await queryOne<GrowthSignalRow>(
    env.DB,
    `SELECT * FROM growth_signals WHERE signal_id = ? LIMIT 1`,
    [signalId],
  );
  if (!row) throw new Error('Failed to load upserted growth signal');
  return asSignalView(row);
}

export async function listGrowthSignals(env: Env, filters: GrowthSignalListFilters = {}): Promise<GrowthSignalView[]> {
  const conditions = ['tenant_id = ?'];
  const params: unknown[] = [normalizeTenantId(filters.tenantId)];
  const status = filters.status ?? GROWTH_SIGNAL_STATUS.ACTIVE;

  conditions.push('status = ?');
  params.push(status);

  if (!filters.includeExpired) {
    conditions.push('expires_at > ?');
    params.push(now());
  }
  if (filters.subjectId) {
    conditions.push('subject_id = ?');
    params.push(normalizeSubjectId(filters.subjectId));
  }
  if (filters.subjectType) {
    conditions.push('subject_type = ?');
    params.push(filters.subjectType.trim().toLowerCase());
  }
  if (filters.signalType) {
    conditions.push('signal_type = ?');
    params.push(filters.signalType.trim());
  }
  if (filters.severity) {
    conditions.push('severity = ?');
    params.push(filters.severity.trim().toLowerCase());
  }

  const limit = clampInteger(filters.limit ?? GROWTH_POLICY.DEFAULT_LIST_LIMIT, 1, GROWTH_POLICY.MAX_LIST_LIMIT);
  params.push(limit);

  const rows = await query<GrowthSignalRow>(
    env.DB,
    `SELECT *
       FROM growth_signals
      WHERE ${conditions.join(' AND ')}
      ORDER BY CASE severity
        WHEN 'critical' THEN 4
        WHEN 'high' THEN 3
        WHEN 'medium' THEN 2
        ELSE 1 END DESC,
        confidence DESC,
        detected_at DESC
      LIMIT ?`,
    params,
  );

  return rows.map(asSignalView);
}

export async function getGrowthSignal(env: Env, signalId: string): Promise<GrowthSignalView | null> {
  const row = await queryOne<GrowthSignalRow>(
    env.DB,
    `SELECT * FROM growth_signals WHERE signal_id = ? LIMIT 1`,
    [signalId],
  );
  return row ? asSignalView(row) : null;
}

export async function getSubjectGrowthContext(
  env: Env,
  subjectId: string,
  tenantId?: string | null,
): Promise<Record<string, unknown>> {
  const normalizedSubject = normalizeSubjectId(subjectId);
  const inferredDomain = normalizedSubject.includes('@') ? normalizedSubject.split('@').pop() ?? normalizedSubject : normalizedSubject;
  const normalizedTenant = normalizeTenantId(tenantId);

  const [contact, suppression, signals, recentEmails, prospectChannels, skripIdentities, recentActions] = await Promise.all([
    queryOne(
      env.DB,
      `SELECT id, email, status, source, affiliate_code, first_seen_at, converted_at, plan, gateway, total_spent_cents, metadata, updated_at
         FROM marketing_contacts
        WHERE lower(email) = ?
        LIMIT 1`,
      [normalizedSubject],
    ),
    queryOne(
      env.DB,
      `SELECT reason, source, created_at, metadata
         FROM suppression_list
        WHERE email = ?
        LIMIT 1`,
      [normalizedSubject],
    ),
    listGrowthSignals(env, { tenantId: normalizedTenant, subjectId: normalizedSubject, includeExpired: false, limit: 25 }),
    query(
      env.DB,
      `SELECT es.id, es.status, es.scheduled_at, es.sent_at, es.opened_at, es.clicked_at, es.replied_at,
              seq.trigger_event, seq.name AS sequence_name
         FROM email_sends es
    LEFT JOIN email_sequences seq ON seq.id = es.sequence_id
        WHERE lower(es.contact_email) = ?
        ORDER BY es.id DESC
        LIMIT 20`,
      [normalizedSubject],
    ),
    query(
      env.DB,
      `SELECT prospect_domain, contact_email, channel_type, channel_value, priority, detected_at
         FROM prospect_channels
        WHERE prospect_domain = ? OR lower(contact_email) = ?
        ORDER BY priority ASC
        LIMIT 25`,
      [inferredDomain, normalizedSubject],
    ),
    query(
      env.DB,
      `SELECT channel, consent_state, suppression_state, availability_state, registration_state, identity_confidence, updated_at
         FROM contact_channel_identities
        WHERE tenant_id = ? AND external_contact_id = ?
        ORDER BY channel ASC`,
      [normalizedTenant, normalizedSubject],
    ),
    query(
      env.DB,
      `SELECT action_id, proposed_action, status, risk_level, confidence, created_at, executed_at, outcome_due_at
         FROM agent_actions
        WHERE tenant_id = ? AND subject_id = ?
        ORDER BY created_at DESC
        LIMIT 20`,
      [normalizedTenant, normalizedSubject],
    ),
  ]);

  return {
    tenantId: normalizedTenant,
    subjectId: normalizedSubject,
    inferredDomain,
    lifecycle: contact ?? null,
    suppression: suppression ?? null,
    signals,
    recentEmails,
    channelReachability: {
      prospectChannels,
      skripIdentities,
    },
    recentActions,
  };
}

function stringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function sourceEventId(record: Record<string, unknown>): string | null {
  return stringField(record, ['eventId', 'idempotencyKey', 'nonce', '_platformEventId']);
}

export async function materializeGrowthSignalsFromEvent(
  env: Env,
  eventType: string,
  payload: unknown,
  timestamp: string,
): Promise<GrowthSignalView[]> {
  if (!isRecord(payload)) return [];

  const detectedAt = isoToEpochSeconds(timestamp);
  const sourceEvent = sourceEventId(payload);
  const createdSignals: GrowthSignalView[] = [];
  const recordSignal = async (input: GrowthSignalInput) => {
    createdSignals.push(await upsertGrowthSignal(env, { ...input, detectedAt, sourceEventId: sourceEvent }));
  };

  switch (eventType) {
    case EVENT_TYPES.AUDIT_COMPLETED: {
      const domain = stringField(payload, ['domain']);
      if (!domain) break;
      const score = numberField(payload, ['score']) ?? 50;
      await recordSignal({
        subjectType: GROWTH_SUBJECT_TYPE.DOMAIN,
        subjectId: domain,
        signalType: GROWTH_SIGNAL_TYPE.AUDIT_COMPLETED_NO_SIGNUP,
        severity: score < 60 ? GROWTH_SIGNAL_SEVERITY.HIGH : GROWTH_SIGNAL_SEVERITY.MEDIUM,
        confidence: score < 60 ? 82 : 68,
        evidence: { eventType, domain, score, grade: stringField(payload, ['grade']), url: stringField(payload, ['url']) },
      });
      break;
    }

    case EVENT_TYPES.LEAD_CAPTURED: {
      const email = stringField(payload, ['email']);
      if (!email) break;
      await recordSignal({
        subjectType: GROWTH_SUBJECT_TYPE.CONTACT,
        subjectId: email,
        signalType: GROWTH_SIGNAL_TYPE.WARM_AUDIT_LEAD_FOLLOWUP,
        severity: GROWTH_SIGNAL_SEVERITY.HIGH,
        confidence: 88,
        evidence: { eventType, domain: stringField(payload, ['domain']), score: numberField(payload, ['score']), grade: stringField(payload, ['grade']) },
      });
      break;
    }

    case EVENT_TYPES.USER_SIGNUP: {
      const subject = stringField(payload, ['email', 'userId']);
      if (!subject) break;
      await recordSignal({
        subjectType: GROWTH_SUBJECT_TYPE.CONTACT,
        subjectId: subject,
        signalType: GROWTH_SIGNAL_TYPE.SIGNUP_NO_SITE_CONNECTED,
        severity: GROWTH_SIGNAL_SEVERITY.MEDIUM,
        confidence: 66,
        evidence: { eventType, provider: stringField(payload, ['provider']), referrer: stringField(payload, ['referrer']) },
      });
      break;
    }

    case EVENT_TYPES.APP_INSTALLED: {
      const subject = stringField(payload, ['email', 'shop']);
      if (!subject) break;
      await recordSignal({
        subjectType: stringField(payload, ['email']) ? GROWTH_SUBJECT_TYPE.CONTACT : GROWTH_SUBJECT_TYPE.SHOP,
        subjectId: subject,
        signalType: GROWTH_SIGNAL_TYPE.INSTALLED_NO_FIRST_ANALYSIS,
        severity: GROWTH_SIGNAL_SEVERITY.MEDIUM,
        confidence: 72,
        evidence: { eventType, shop: stringField(payload, ['shop']), plan: stringField(payload, ['plan']) },
      });
      break;
    }

    case EVENT_TYPES.FIRST_ANALYSIS: {
      const subject = stringField(payload, ['email', 'shop']);
      if (!subject) break;
      await recordSignal({
        subjectType: stringField(payload, ['email']) ? GROWTH_SUBJECT_TYPE.CONTACT : GROWTH_SUBJECT_TYPE.SHOP,
        subjectId: subject,
        signalType: GROWTH_SIGNAL_TYPE.FIRST_ANALYSIS_NO_RETURN,
        severity: GROWTH_SIGNAL_SEVERITY.MEDIUM,
        confidence: 70,
        evidence: { eventType, shop: stringField(payload, ['shop']), score: numberField(payload, ['score']), pagesAnalyzed: numberField(payload, ['pagesAnalyzed']) },
      });
      break;
    }

    case EVENT_TYPES.APP_UNINSTALLED: {
      const subject = stringField(payload, ['email', 'shop']);
      if (!subject) break;
      await recordSignal({
        subjectType: stringField(payload, ['email']) ? GROWTH_SUBJECT_TYPE.CONTACT : GROWTH_SUBJECT_TYPE.SHOP,
        subjectId: subject,
        signalType: GROWTH_SIGNAL_TYPE.UNINSTALL_WITH_RECENT_ENGAGEMENT,
        severity: GROWTH_SIGNAL_SEVERITY.HIGH,
        confidence: 78,
        evidence: { eventType, shop: stringField(payload, ['shop']), shopName: stringField(payload, ['shopName']) },
      });
      break;
    }

    case EVENT_TYPES.TRIAL_EXPIRING: {
      const userId = stringField(payload, ['userId']);
      if (!userId) break;
      await recordSignal({
        subjectType: GROWTH_SUBJECT_TYPE.CONTACT,
        subjectId: userId,
        signalType: GROWTH_SIGNAL_TYPE.TRIAL_EXPIRING_HIGH_INTENT,
        severity: GROWTH_SIGNAL_SEVERITY.HIGH,
        confidence: 80,
        evidence: { eventType, plan: stringField(payload, ['plan']), daysRemaining: numberField(payload, ['daysRemaining']) },
      });
      break;
    }

    case EVENT_TYPES.OUTBOUND_PROSPECT_ENRICHED: {
      const subject = stringField(payload, ['contactEmail', 'domain']);
      if (!subject) break;
      const score = numberField(payload, ['score']) ?? 0;
      const auditScore = numberField(payload, ['auditScore']);
      if (score >= 60 || (auditScore !== null && auditScore < 70)) {
        await recordSignal({
          subjectType: subject.includes('@') ? GROWTH_SUBJECT_TYPE.CONTACT : GROWTH_SUBJECT_TYPE.DOMAIN,
          subjectId: subject,
          signalType: GROWTH_SIGNAL_TYPE.AUDIT_GRADE_LOW_HIGH_FIT,
          severity: auditScore !== null && auditScore < 60 ? GROWTH_SIGNAL_SEVERITY.HIGH : GROWTH_SIGNAL_SEVERITY.MEDIUM,
          confidence: Math.min(92, 55 + Math.floor(score / 2)),
          evidence: {
            eventType,
            domain: stringField(payload, ['domain']),
            score,
            auditScore,
            auditGrade: stringField(payload, ['auditGrade']),
            capabilityHook: isRecord(payload.capabilityHook) ? payload.capabilityHook : null,
          },
        });
      }
      break;
    }

    case EVENT_TYPES.SHARE_CREATED: {
      const token = stringField(payload, ['token']);
      if (!token) break;
      await recordSignal({
        subjectType: GROWTH_SUBJECT_TYPE.SHARE,
        subjectId: token,
        signalType: GROWTH_SIGNAL_TYPE.SHARE_CREATED_NO_CONVERSION,
        severity: GROWTH_SIGNAL_SEVERITY.LOW,
        confidence: 58,
        evidence: { eventType, owner: stringField(payload, ['owner']), role: stringField(payload, ['role']), tier: stringField(payload, ['tier']) },
      });
      break;
    }

    case EVENT_TYPES.SHARE_CTA_CLICKED: {
      const token = stringField(payload, ['token', 'shareToken']);
      if (!token) break;
      await recordSignal({
        subjectType: GROWTH_SUBJECT_TYPE.SHARE,
        subjectId: token,
        signalType: GROWTH_SIGNAL_TYPE.SHARE_CREATED_NO_CONVERSION,
        severity: GROWTH_SIGNAL_SEVERITY.MEDIUM,
        confidence: 74,
        evidence: { eventType, dwellSeconds: numberField(payload, ['dwellSeconds']), pqlScoreHint: numberField(payload, ['pqlScoreHint']) },
      });
      break;
    }

    case EVENT_TYPES.OUTBOUND_EMAIL_CLICKED: {
      const email = stringField(payload, ['email', 'contactEmail']);
      if (!email) break;
      await recordSignal({
        subjectType: GROWTH_SUBJECT_TYPE.CONTACT,
        subjectId: email,
        signalType: GROWTH_SIGNAL_TYPE.COLD_CLICKED_NO_REPLY,
        severity: GROWTH_SIGNAL_SEVERITY.HIGH,
        confidence: 84,
        evidence: { eventType, link: stringField(payload, ['link']), messageId: stringField(payload, ['messageId']), tag: stringField(payload, ['tag']) },
      });
      break;
    }

    case EVENT_TYPES.AFFILIATE_CLICK: {
      const affiliateCode = stringField(payload, ['affiliateCode']);
      if (!affiliateCode) break;
      const landingPage = stringField(payload, ['landingPage']);
      await recordSignal({
        subjectType: GROWTH_SUBJECT_TYPE.AFFILIATE,
        subjectId: affiliateCode,
        signalType: GROWTH_SIGNAL_TYPE.AFFILIATE_CLICK_NO_SIGNUP,
        severity: GROWTH_SIGNAL_SEVERITY.LOW,
        confidence: 55,
        evidence: { eventType, landingPage, country: stringField(payload, ['country']) },
      });
      if (landingPage?.toLowerCase().includes('pricing')) {
        await recordSignal({
          subjectType: GROWTH_SUBJECT_TYPE.AFFILIATE,
          subjectId: affiliateCode,
          signalType: GROWTH_SIGNAL_TYPE.PRICING_VISIT_NO_SIGNUP,
          severity: GROWTH_SIGNAL_SEVERITY.MEDIUM,
          confidence: 70,
          evidence: { eventType, landingPage, country: stringField(payload, ['country']) },
        });
      }
      break;
    }
  }

  return createdSignals;
}