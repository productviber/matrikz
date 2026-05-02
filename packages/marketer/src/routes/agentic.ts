import type { Env, ProposedAgentAction } from '../types';
import { AGENT_ACTION_TYPE, AGENT_RISK_LEVEL, GROWTH_POLICY } from '../constants';
import { badRequest, created, forbidden, notFound, ok, serverError } from '../lib/response';
import { hasAgenticScope } from '../lib/access';
import { createAiEngineClient } from '../lib/ai-engine/client';
import {
  getGrowthSignal,
  getSubjectGrowthContext,
  listGrowthSignals,
} from '../lib/growth/signals';
import {
  createAgentActionProposal,
  dryRunAgentAction,
  executeAgentAction,
  getAgentAction,
  listAgentActionEvents,
} from '../lib/growth/actions';
import { evaluateGrowthPolicy } from '../lib/growth/policy';
import { isRecord, normalizeSubjectId, normalizeTenantId } from '../lib/growth/common';

function requireScope(request: Request, env: Env, scope: string): Response | null {
  if (hasAgenticScope(request, env, scope)) return null;
  return forbidden(`Missing agent scope: ${scope}`);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json() as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseLimit(url: URL): number {
  const raw = Number.parseInt(url.searchParams.get('limit') ?? String(GROWTH_POLICY.DEFAULT_LIST_LIMIT), 10);
  if (!Number.isFinite(raw)) return GROWTH_POLICY.DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(raw, 1), GROWTH_POLICY.MAX_LIST_LIMIT);
}

function proposedActionFromUnknown(value: unknown): ProposedAgentAction | null {
  if (!isRecord(value)) return null;
  const type = typeof value.type === 'string' ? value.type : null;
  if (!type) return null;
  const params = isRecord(value.params) ? value.params : {};
  const reason = typeof value.reason === 'string' ? value.reason : undefined;
  return { type, params, reason };
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function handleListGrowthSignals(request: Request, env: Env): Promise<Response> {
  const denied = requireScope(request, env, 'signals:read');
  if (denied) return denied;

  const url = new URL(request.url);
  const signals = await listGrowthSignals(env, {
    tenantId: url.searchParams.get('tenantId'),
    status: url.searchParams.get('status') ?? undefined,
    subjectId: url.searchParams.get('subjectId') ?? undefined,
    subjectType: url.searchParams.get('subjectType') ?? undefined,
    signalType: url.searchParams.get('signalType') ?? undefined,
    severity: url.searchParams.get('severity') ?? undefined,
    includeExpired: url.searchParams.get('includeExpired') === 'true',
    limit: parseLimit(url),
  });
  return ok({ signals, count: signals.length });
}

async function handleSubjectContext(request: Request, env: Env, subjectId: string): Promise<Response> {
  const denied = requireScope(request, env, 'subjects:read');
  if (denied) return denied;
  const url = new URL(request.url);
  const context = await getSubjectGrowthContext(env, decodeURIComponent(subjectId), url.searchParams.get('tenantId'));
  return ok(context);
}

async function resolveProposalInput(env: Env, body: Record<string, unknown>): Promise<{
  tenantId: string;
  subjectId: string;
  signalId: string | null;
  signals: unknown[];
  context: Record<string, unknown>;
}> {
  const tenantId = normalizeTenantId(stringField(body, 'tenantId'));
  const signalId = stringField(body, 'signalId');
  const signal = signalId ? await getGrowthSignal(env, signalId) : null;
  const subjectId = normalizeSubjectId(stringField(body, 'subjectId') ?? signal?.subject_id ?? '');
  if (!subjectId) throw new Error('subjectId or signalId is required');

  const context = await getSubjectGrowthContext(env, subjectId, tenantId);
  const signals = signal
    ? [signal]
    : await listGrowthSignals(env, { tenantId, subjectId, limit: 10 });
  return { tenantId, subjectId, signalId: signalId ?? signal?.signal_id ?? null, signals, context };
}

async function handleProposeAction(request: Request, env: Env): Promise<Response> {
  const denied = requireScope(request, env, 'actions:propose');
  if (denied) return denied;

  const body = await readJsonBody(request);
  if (!body) return badRequest('Invalid JSON body');

  try {
    const proposalInput = await resolveProposalInput(env, body);
    const suppliedAction = proposedActionFromUnknown(body.proposedAction) ?? proposedActionFromUnknown(body.action);
    const useAi = body.useAi !== false && !suppliedAction;
    const aiClient = createAiEngineClient(env);
    const aiResult = useAi
      ? await aiClient.growthNextAction({
          tenantId: proposalInput.tenantId,
          subjectId: proposalInput.subjectId,
          signals: proposalInput.signals,
          context: proposalInput.context,
        })
      : null;

    const action = suppliedAction ?? aiResult?.action ?? {
      type: AGENT_ACTION_TYPE.MANUAL_REVIEW,
      params: { reason: 'no_action_supplied' },
      reason: 'No action was supplied and ai-engine was not used.',
    };
    const riskLevel = stringField(body, 'riskLevel') ?? aiResult?.riskLevel ?? AGENT_RISK_LEVEL.MEDIUM;
    const confidence = numberField(body, 'confidence') ?? aiResult?.confidence ?? GROWTH_POLICY.DEFAULT_CONFIDENCE;
    const agentId = stringField(body, 'agentId') ?? GROWTH_POLICY.DEFAULT_AGENT_ID;
    const policyResult = await evaluateGrowthPolicy(env, {
      tenantId: proposalInput.tenantId,
      subjectId: proposalInput.subjectId,
      action,
      riskLevel,
      confidence,
    });
    const actionView = await createAgentActionProposal(env, {
      agentId,
      tenantId: proposalInput.tenantId,
      subjectId: proposalInput.subjectId,
      signalId: proposalInput.signalId,
      action,
      riskLevel,
      confidence,
      evidence: {
        signals: proposalInput.signals,
        aiExplanation: aiResult?.explanation ?? null,
      },
      requestSnapshot: {
        tenantId: proposalInput.tenantId,
        subjectId: proposalInput.subjectId,
        signalId: proposalInput.signalId,
        suppliedAction: Boolean(suppliedAction),
        useAi,
      },
      aiMetadata: aiResult?.metadata ?? null,
      policyResult,
    });

    return created({ action: actionView, policyResult, ai: aiResult?.metadata ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return badRequest(message);
  }
}

async function handleDryRunAction(request: Request, env: Env): Promise<Response> {
  const denied = requireScope(request, env, 'actions:dry_run');
  if (denied) return denied;

  const body = await readJsonBody(request);
  if (!body) return badRequest('Invalid JSON body');

  try {
    const actionId = stringField(body, 'actionId') ?? undefined;
    const action = proposedActionFromUnknown(body.action) ?? proposedActionFromUnknown(body.proposedAction) ?? undefined;
    const result = await dryRunAgentAction(env, {
      actionId,
      tenantId: stringField(body, 'tenantId'),
      subjectId: stringField(body, 'subjectId') ?? undefined,
      action,
      riskLevel: stringField(body, 'riskLevel') ?? undefined,
      confidence: numberField(body, 'confidence') ?? undefined,
    });
    return ok(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return badRequest(message);
  }
}

async function handleExecuteAction(request: Request, env: Env): Promise<Response> {
  const denied = requireScope(request, env, 'actions:execute_low_risk');
  if (denied) return denied;

  const body = await readJsonBody(request);
  if (!body) return badRequest('Invalid JSON body');
  const actionId = stringField(body, 'actionId');
  if (!actionId) return badRequest('actionId is required');

  try {
    const result = await executeAgentAction(env, actionId);
    return ok(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) return notFound(message);
    return serverError(message);
  }
}

async function handleGetAction(request: Request, env: Env, actionId: string): Promise<Response> {
  const denied = requireScope(request, env, 'actions:read');
  if (denied) return denied;
  const action = await getAgentAction(env, actionId);
  if (!action) return notFound('Agent action not found');
  return ok({ action });
}

async function handleGetActionAudit(request: Request, env: Env, actionId: string): Promise<Response> {
  const denied = requireScope(request, env, 'actions:read');
  if (denied) return denied;
  const action = await getAgentAction(env, actionId);
  if (!action) return notFound('Agent action not found');
  const events = await listAgentActionEvents(env, actionId);
  return ok({ action, events });
}

export async function handleAgenticRoute(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'GET' && path === '/api/agentic/growth-signals') {
    return handleListGrowthSignals(request, env);
  }

  const subjectMatch = path.match(/^\/api\/agentic\/subjects\/([^/]+)\/context$/);
  if (method === 'GET' && subjectMatch) {
    return handleSubjectContext(request, env, subjectMatch[1]);
  }

  if (method === 'POST' && path === '/api/agentic/actions/propose') {
    return handleProposeAction(request, env);
  }
  if (method === 'POST' && path === '/api/agentic/actions/dry-run') {
    return handleDryRunAction(request, env);
  }
  if (method === 'POST' && path === '/api/agentic/actions/execute') {
    return handleExecuteAction(request, env);
  }

  const actionMatch = path.match(/^\/api\/agentic\/actions\/([^/]+)(\/audit)?$/);
  if (method === 'GET' && actionMatch) {
    const actionId = decodeURIComponent(actionMatch[1]);
    return actionMatch[2]
      ? handleGetActionAudit(request, env, actionId)
      : handleGetAction(request, env, actionId);
  }

  return notFound('Agentic route not found');
}