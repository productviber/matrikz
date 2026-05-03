/**
 * Skrip Contact Registration
 *
 * Upserts a contact's channel identity into Skrip via /v1/contacts/upsert,
 * persists the canonical_id returned by Skrip into contact_channel_identities,
 * and provides a reconciliation scan for rows missing a canonical_id.
 */

import type { ContactChannelIdentityRow, Env } from '../../types';
import { SKRIP_CONFIG } from '../../constants';
import { execute, now, query } from '../db';
import { createSkripClient } from './client';

// ── Skrip API types ────────────────────────────────────────────────────────

/** Identifier types accepted by the Skrip /v1/contacts/upsert endpoint. */
export type SkripIdentifierType =
  | 'push_endpoint'
  | 'phone'
  | 'email'
  | 'wa_phone'
  | 'tg_chat_id'
  | 'device_fingerprint'
  | 'cookie_id';

/** Maps our internal channel names to the Skrip identifier type. */
export const CHANNEL_TO_IDENTIFIER_TYPE: Record<string, SkripIdentifierType> = {
  push: 'push_endpoint',
  sms: 'phone',
  email: 'email',
  whatsapp: 'wa_phone',
  telegram: 'tg_chat_id',
};

export interface SkripContactUpsertRequest {
  tenantId: string;
  externalContactId: string;
  identifiers: Array<{ type: SkripIdentifierType; value: string }>;
  consentState?: string;
  suppressionState?: string;
}

export interface SkripContactUpsertResponse {
  ok: boolean;
  requestId?: string;
  data: {
    canonicalId: string;
    isNew: boolean;
    confidence: number;
    method: string;
    mergedFrom: string[];
    identifiersMapped: number;
  };
}

// ── Registration ───────────────────────────────────────────────────────────

export interface RegisterContactChannelInput {
  tenantId?: string;
  externalContactId: string;
  channel: string;
  /**
   * Channel-specific address. Examples:
   *   push  → Web Push subscription JSON or FCM registration token
   *   sms   → E.164 phone number
   *   whatsapp → E.164 phone number
   *   telegram → Telegram chat_id
   */
  address: string;
  consentState?: string;
  suppressionState?: string;
  availabilityState?: string;
  identityConfidence?: number;
  profile?: Record<string, unknown>;
  tags?: string[];
}

export interface RegisterContactChannelResult {
  canonicalId: string | null;
  registrationState: 'registered' | 'pending';
  skripStatus: 'registered' | 'local_only';
  localUpdated: boolean;
}

/**
 * Register (or re-register) a contact's channel identity.
 *
 * 1. Upserts a row in contact_channel_identities with registration_state='pending'.
 * 2. Calls Skrip /v1/contacts/upsert and obtains a canonical_id.
 * 3. Updates the local row to registration_state='registered' with the canonical_id.
 *
 * If Skrip is not configured or errors, the row is kept as 'pending' so a
 * reconciliation job can retry without data loss.
 */
export async function registerContactChannel(
  env: Env,
  input: RegisterContactChannelInput,
): Promise<RegisterContactChannelResult> {
  const tenantId = input.tenantId ?? SKRIP_CONFIG.DEFAULT_TENANT_ID;
  const epoch = now();

  // Step 1: persist locally as pending
  await execute(
    env.DB,
    `INSERT INTO contact_channel_identities
      (tenant_id, external_contact_id, canonical_id, channel, consent_state, suppression_state, availability_state, identity_confidence, registration_state, address, last_reconciled_at, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)
     ON CONFLICT(tenant_id, external_contact_id, channel) DO UPDATE SET
       consent_state = excluded.consent_state,
       suppression_state = excluded.suppression_state,
       availability_state = excluded.availability_state,
       identity_confidence = excluded.identity_confidence,
       address = excluded.address,
       updated_at = excluded.updated_at`,
    [
      tenantId,
      input.externalContactId,
      input.channel,
      input.consentState ?? 'opted_in',
      input.suppressionState ?? 'clear',
      input.availabilityState ?? 'available',
      input.identityConfidence ?? 1.0,
      input.address,
      epoch,
      epoch,
    ],
  );

  // Step 2: call Skrip
  const client = createSkripClient(env);
  if (!client.configured) {
    return { canonicalId: null, registrationState: 'pending', skripStatus: 'local_only', localUpdated: true };
  }

  let canonicalId: string | null = null;
  let skripStatus: 'registered' | 'local_only' = 'local_only';

  try {
    const identifierType = CHANNEL_TO_IDENTIFIER_TYPE[input.channel] ?? 'push_endpoint';
    const response = await client.registerContact<SkripContactUpsertResponse>(tenantId, {
      tenantId,
      externalContactId: input.externalContactId,
      identifiers: [{ type: identifierType, value: input.address }],
      consentState: input.consentState ?? 'opted_in',
      suppressionState: input.suppressionState ?? 'clear',
    } satisfies SkripContactUpsertRequest);

    canonicalId = response.data.canonicalId;
    skripStatus = 'registered';

    // Step 3: update with canonical_id and registered state
    await execute(
      env.DB,
      `UPDATE contact_channel_identities
          SET canonical_id = ?,
              registration_state = 'registered',
              address = ?,
              last_reconciled_at = ?,
              updated_at = ?
        WHERE tenant_id = ? AND external_contact_id = ? AND channel = ?`,
      [canonicalId, input.address, epoch, epoch, tenantId, input.externalContactId, input.channel],
    );
  } catch (err) {
    console.warn(
      `[Registration] Skrip upsert failed for ${input.externalContactId}/${input.channel}: ${err instanceof Error ? err.message : err}`,
    );
  }

  return {
    canonicalId,
    registrationState: canonicalId ? 'registered' : 'pending',
    skripStatus,
    localUpdated: true,
  };
}

// ── Reconciliation ─────────────────────────────────────────────────────────

export interface ReconciliationResult {
  scanned: number;
  registered: number;
  failed: number;
  errors?: string[];
}

/**
 * Scan contact_channel_identities rows where registration_state='pending'
 * (i.e. canonical_id is missing) and attempt to register them with Skrip.
 *
 * This is intended to run as a low-priority background job — invoke from
 * the scheduled handler or the admin trigger endpoint.
 */
export async function reconcilePendingIdentities(
  env: Env,
  batchSize = 50,
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = { scanned: 0, registered: 0, failed: 0 };

  const rows = await query<ContactChannelIdentityRow>(
    env.DB,
    `SELECT *
       FROM contact_channel_identities
      WHERE registration_state = 'pending'
        AND (last_reconciled_at IS NULL OR last_reconciled_at < ?)
      ORDER BY last_reconciled_at ASC NULLS FIRST
      LIMIT ?`,
    [now() - 3600, batchSize],
  );
  result.scanned = rows.length;

  const client = createSkripClient(env);
  if (!client.configured) return result;

  for (const row of rows) {
    try {
      const identifierType = CHANNEL_TO_IDENTIFIER_TYPE[row.channel] ?? 'push_endpoint';
      const address = row.address ?? row.external_contact_id;
      const response = await client.registerContact<SkripContactUpsertResponse>(row.tenant_id, {
        tenantId: row.tenant_id,
        externalContactId: row.external_contact_id,
        identifiers: [{ type: identifierType, value: address }],
        consentState: row.consent_state,
        suppressionState: row.suppression_state,
      } satisfies SkripContactUpsertRequest);

      const epoch = now();
      await execute(
        env.DB,
        `UPDATE contact_channel_identities
            SET canonical_id = ?,
                registration_state = 'registered',
                last_reconciled_at = ?,
                updated_at = ?
          WHERE id = ?`,
        [response.data.canonicalId, epoch, epoch, row.id],
      );
      result.registered++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[Reconcile] Skrip upsert failed for id=${row.id} ext=${row.external_contact_id} channel=${row.channel}: ${msg}`,
      );
      (result.errors ??= []).push(`id=${row.id}: ${msg}`);
      // Mark last_reconciled_at to avoid hammering the same row every sweep
      await execute(
        env.DB,
        `UPDATE contact_channel_identities SET last_reconciled_at = ?, updated_at = ? WHERE id = ?`,
        [now(), now(), row.id],
      );
      result.failed++;
    }
  }

  return result;
}
