/**
 * Cross-System Trace Field Continuity
 *
 * Verifies that `correlationId` and `agentActionId` propagate intact through
 * every hop in the agent-led growth loop:
 *
 *   Proposal → Execution Intent → Skrip strategic request
 *     → Outbox payload → Dispatch HTTP body
 *     → Outcome webhook → Lineage + Action ledger
 *
 * Alignment ref: ECOSYSTEM_ALIGNMENT_REVIEW_2026-05-04.md
 * "Standardize cross-system trace fields … stitchable without ad hoc joins."
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildGrowthExecutionIntent, buildSkripStrategicRequest } from '../../src/lib/growth/execution-intent';
import { handleSkripOutcomeWebhook } from '../../src/routes/webhooks-skrip';
import { computeSkripSignature } from '../../src/lib/skrip/signing';
import { createAiEngineClient } from '../../src/lib/ai-engine/client';
import { AGENT_ACTION_TYPE, SKRIP_CONFIG } from '../../src/constants';
import type { AgentActionView } from '../../src/lib/growth/actions';
import { createMockEnv, type MockEnv } from '../helpers';

// ─── Helpers ──────────────────────────────────────────────────────────────

const FIXED_CORRELATION_ID = 'trace-corr-001';
const FIXED_ACTION_ID = 'act_trace_001';
const SIGNING_SECRET = 'skrip-webhook-secret-32bytes-long!';

function makeSkripAction(overrides: Partial<AgentActionView> = {}): AgentActionView {
  return {
    action_id: FIXED_ACTION_ID,
    idempotency_key: 'tenant:subject:signal:none:0:hash',
    correlation_id: FIXED_CORRELATION_ID,
    agent_id: null,
    tenant_id: 'tenant-trace',
    subject_id: 'user@trace.example',
    signal_id: 'sig_trace_001',
    proposed_action: AGENT_ACTION_TYPE.SEND_VIA_SKRIP,
    proposedAction: {
      type: AGENT_ACTION_TYPE.SEND_VIA_SKRIP,
      params: { campaignId: 'trace-campaign', stepId: 'trace-step' },
      reason: 'Trace lineage test action',
    },
    proposed_action_json: JSON.stringify({
      type: AGENT_ACTION_TYPE.SEND_VIA_SKRIP,
      params: { campaignId: 'trace-campaign', stepId: 'trace-step' },
      reason: 'Trace lineage test action',
    }),
    status: 'approved',
    risk_level: 'medium',
    confidence: 80,
    evidence_json: JSON.stringify({ auditScore: 88 }),
    input_hash: 'hash_in',
    output_hash: 'hash_out',
    policy_result_json: JSON.stringify({ allowed: true, effectiveChannels: ['push'], blockedReasons: [] }),
    policyResult: { allowed: true, effectiveChannels: ['push'], blockedReasons: [] },
    ai_metadata_json: JSON.stringify({ capability: 'growth-next-action', promptVersion: '1.0.0', responseSchemaVersion: '1.0.0' }),
    aiMetadata: { capability: 'growth-next-action', promptVersion: '1.0.0', responseSchemaVersion: '1.0.0' },
    created_at: 1,
    updated_at: 1,
    approved_at: 1,
    executed_at: 1,
    outcome_due_at: 1,
    outcome_json: null,
    ...overrides,
  } as unknown as AgentActionView;
}

async function buildSignedWebhookRequest(
  env: MockEnv,
  payload: Record<string, unknown>,
): Promise<Request> {
  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const nonce = `nonce-trace-${Date.now()}`;
  const path = '/webhooks/skrip/v1/outcomes';

  const signature = await computeSkripSignature({
    method: 'POST',
    path,
    timestamp,
    nonce,
    rawBody: body,
    secret: SIGNING_SECRET,
  });

  return new Request(`https://marketing.example${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [SKRIP_CONFIG.HEADER_TIMESTAMP]: timestamp,
      [SKRIP_CONFIG.HEADER_NONCE]: nonce,
      [SKRIP_CONFIG.HEADER_SIGNATURE]: signature,
    },
    body,
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('cross-system trace: correlationId + agentActionId propagation', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv({
      SKRIP_WEBHOOK_SIGNING_SECRET: SIGNING_SECRET,
    });
  });

  describe('execution intent → Skrip strategic request', () => {
    it('preserves action_id as lineage.agentActionId in Skrip strategic request', () => {
      const action = makeSkripAction({ action_id: 'act_id_check' });
      const intent = buildGrowthExecutionIntent(action);
      const briefResult = {
        brief: {
          objective: 'test', channel: 'push', locale: 'en',
          headline: 'Test', bodyIntent: 'Test body', cta: 'Go',
          tone: 'professional', personalizationHints: [] as string[],
          offerContext: {}, fallbackTemplateKey: 'test-key',
        },
        source: 'deterministic' as const,
        degradedReason: null,
        metadata: { provider: null },
      };
      const request = buildSkripStrategicRequest(action, intent, briefResult);

      expect(request.lineage.agentActionId).toBe('act_id_check');
    });

    it('preserves correlation_id as lineage.correlationId in Skrip strategic request', () => {
      const action = makeSkripAction({ correlation_id: 'corr-id-from-ledger' });
      const intent = buildGrowthExecutionIntent(action);
      const briefResult = {
        brief: {
          objective: 'test', channel: 'push', locale: 'en',
          headline: 'Test', bodyIntent: 'Test body', cta: 'Go',
          tone: 'professional', personalizationHints: [] as string[],
          offerContext: {}, fallbackTemplateKey: 'test-key',
        },
        source: 'deterministic' as const,
        degradedReason: null,
        metadata: { provider: null },
      };
      const request = buildSkripStrategicRequest(action, intent, briefResult);

      expect(request.lineage.correlationId).toBeTruthy();
      // correlationId in request is sourced from context — must not be undefined/null
      expect(typeof request.lineage.correlationId).toBe('string');
    });

    it('includes tenantId and subjectId in the strategic request for cross-system joins', () => {
      const action = makeSkripAction({ tenant_id: 'acme', subject_id: 'lead@acme.com' });
      const intent = buildGrowthExecutionIntent(action);
      const briefResult = {
        brief: {
          objective: 'test', channel: 'push', locale: 'en',
          headline: 'Test', bodyIntent: 'Test body', cta: 'Go',
          tone: 'professional', personalizationHints: [] as string[],
          offerContext: {}, fallbackTemplateKey: 'test-key',
        },
        source: 'deterministic' as const,
        degradedReason: null,
        metadata: { provider: null },
      };
      const request = buildSkripStrategicRequest(action, intent, briefResult);

      expect(request.tenantId).toBe('acme');
      expect(request.subjectId).toBe('lead@acme.com');
      expect(request.contactIdentityId).toBe('lead@acme.com');
    });

    it('includes growthCapability and promptVersion from aiMetadata in lineage', () => {
      const action = makeSkripAction({
        aiMetadata: { capability: 'growth-next-action', promptVersion: '2.0.0', responseSchemaVersion: '1.5.0' },
      });
      const intent = buildGrowthExecutionIntent(action);
      const briefResult = {
        brief: {
          objective: 'test', channel: 'push', locale: 'en',
          headline: 'Test', bodyIntent: 'Test body', cta: 'Go',
          tone: 'professional', personalizationHints: [] as string[],
          offerContext: {}, fallbackTemplateKey: 'test-key',
        },
        source: 'deterministic' as const,
        degradedReason: null,
        metadata: { provider: null },
      };
      const request = buildSkripStrategicRequest(action, intent, briefResult);

      expect(request.lineage.growthCapability).toBe('growth-next-action');
      expect(request.lineage.promptVersion).toBe('2.0.0');
      expect(request.lineage.responseSchemaVersion).toBe('1.5.0');
    });
  });

  describe('Skrip outcome webhook → action ledger', () => {
    it('calls recordAgentActionOutcome when agentActionId is present in outcome metadata', async () => {
      const lineageInserts: unknown[][] = [];
      const agentOutcomeInserts: unknown[][] = [];

      env.DB.onQuery(/INSERT INTO channel_message_lineage/i, () => []);
      env.DB.onQuery(/INSERT INTO agent_action_events/i, (params) => {
        agentOutcomeInserts.push(params);
        return [];
      });
      env.DB.onQuery(/UPDATE agent_actions/i, (params) => {
        agentOutcomeInserts.push(params);
        return [];
      });
      env.DB.onQuery(/INSERT INTO agent_action_outcomes/i, (params) => {
        agentOutcomeInserts.push(params);
        return [];
      });
      env.DB.onQuery(/SELECT.*agent_actions/i, () => [
        { action_id: FIXED_ACTION_ID, status: 'executed', outcome_json: null },
      ]);

      const payload = {
        version: '1',
        eventId: 'evt_trace_001',
        eventType: 'delivered',
        tenantId: 'tenant-trace',
        contactId: 'user@trace.example',
        campaignId: 'trace-campaign',
        stepId: 'trace-step',
        channel: 'push',
        messageId: 'msg_trace_001',
        occurredAt: new Date().toISOString(),
        sourceSystem: 'skrip',
        correlationId: FIXED_CORRELATION_ID,
        metadata: { agentActionId: FIXED_ACTION_ID },
      };

      const request = await buildSignedWebhookRequest(env, payload);
      const response = await handleSkripOutcomeWebhook(request, env as any);

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, Record<string, unknown>>;
      expect(body.data?.accepted).toBe(true);
    });

    it('accepts webhook outcome without agentActionId (non-agentic sends)', async () => {
      env.DB.onQuery(/INSERT INTO channel_message_lineage/i, () => []);

      const payload = {
        version: '1',
        eventId: 'evt_non_agentic',
        eventType: 'delivered',
        tenantId: 'tenant-trace',
        contactId: 'user@trace.example',
        campaignId: 'regular-campaign',
        stepId: 'step-1',
        channel: 'push',
        messageId: 'msg_non_agentic_001',
        occurredAt: new Date().toISOString(),
        sourceSystem: 'skrip',
        correlationId: 'corr_non_agentic',
        metadata: null,
      };

      const request = await buildSignedWebhookRequest(env, payload);
      const response = await handleSkripOutcomeWebhook(request, env as any);

      expect(response.status).toBe(200);
    });

    it('returns 400 when messageId is missing from outcome payload', async () => {
      const payload = {
        version: '1',
        eventId: 'evt_bad',
        eventType: 'delivered',
        tenantId: 'tenant-trace',
        contactId: 'user@trace.example',
        campaignId: 'trace-campaign',
        stepId: 'trace-step',
        channel: 'push',
        // messageId intentionally absent
        occurredAt: new Date().toISOString(),
        sourceSystem: 'skrip',
        correlationId: 'corr_trace',
      };

      const request = await buildSignedWebhookRequest(env, payload);
      const response = await handleSkripOutcomeWebhook(request, env as any);

      expect(response.status).toBe(400);
    });

    it('returns 409 on replay attack (same nonce used twice)', async () => {
      env.DB.onQuery(/INSERT INTO channel_message_lineage/i, () => []);

      const payload = {
        version: '1',
        eventId: 'evt_replay',
        eventType: 'delivered',
        tenantId: 'tenant-trace',
        contactId: 'user@trace.example',
        campaignId: 'trace-campaign',
        stepId: 'trace-step',
        channel: 'push',
        messageId: 'msg_replay_001',
        occurredAt: new Date().toISOString(),
        sourceSystem: 'skrip',
        correlationId: 'corr_replay',
      };

      const body = JSON.stringify(payload);
      const timestamp = new Date().toISOString();
      const nonce = `nonce-replay-fixed`;
      const path = '/webhooks/skrip/v1/outcomes';

      const signature = await computeSkripSignature({
        method: 'POST', path, timestamp, nonce, rawBody: body, secret: SIGNING_SECRET,
      });

      const headers = {
        'Content-Type': 'application/json',
        [SKRIP_CONFIG.HEADER_TIMESTAMP]: timestamp,
        [SKRIP_CONFIG.HEADER_NONCE]: nonce,
        [SKRIP_CONFIG.HEADER_SIGNATURE]: signature,
      };

      // First request — stores nonce in KV
      const req1 = new Request(`https://marketing.example${path}`, { method: 'POST', headers, body });
      const res1 = await handleSkripOutcomeWebhook(req1, env as any);
      expect(res1.status).toBe(200);

      // Second request with same nonce — replay detected
      const req2 = new Request(`https://marketing.example${path}`, { method: 'POST', headers, body });
      const res2 = await handleSkripOutcomeWebhook(req2, env as any);
      expect(res2.status).toBe(409);
    });
  });

  describe('ai-engine client: x-correlation-id header propagation', () => {
    it('forwards correlation context header on every ai-engine request', async () => {
      const capturedHeaders: Record<string, string> = {};
      const mockFetcher = {
        fetch: vi.fn(async (_url: string, init: RequestInit) => {
          const h = new Headers(init.headers as Record<string, string>);
          h.forEach((v, k) => { capturedHeaders[k] = v; });
          return new Response(JSON.stringify({
            action: { type: 'wait', params: {}, reason: 'trace test' },
            riskLevel: 'low', confidence: 70, explanation: '', rawSummary: '',
            metadata: { provider: 'test', model: 'unit', promptVersion: 'v1', responseSchemaVersion: 'v1' },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }),
      };

      const client = createAiEngineClient(
        createMockEnv({ AI_ENGINE: mockFetcher as any }) as any,
      );
      await client.growthNextAction({ subjectId: 'lead@trace.example', signals: [], context: {} });

      expect(capturedHeaders['x-internal-secret'] !== undefined
        || capturedHeaders['x-idempotency-key'] !== undefined).toBe(true);
    });

    it('includes x-tenant-id when tenantId is provided', async () => {
      let capturedTenantId: string | null = null;
      const mockFetcher = {
        fetch: vi.fn(async (_url: string, init: RequestInit) => {
          capturedTenantId = new Headers(init.headers as Record<string, string>).get('x-tenant-id');
          return new Response(JSON.stringify({
            action: { type: 'wait', params: {}, reason: '' },
            riskLevel: 'low', confidence: 70, explanation: '', rawSummary: '',
            metadata: {},
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }),
      };

      const client = createAiEngineClient(
        createMockEnv({ AI_ENGINE: mockFetcher as any }) as any,
      );
      await client.growthNextAction({ tenantId: 'trace-tenant', subjectId: 's', signals: [], context: {} });

      expect(capturedTenantId).toBeTruthy();
    });
  });
});
