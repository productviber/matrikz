import type { Env } from '../types';
import type { AccessDecision } from './access';
import {
  ensureAdminAccess,
  ensureAgenticAccess,
  ensureSystemAccess,
  ensureUserAccess,
  ensureWebhookAccess,
} from './access';
import { unauthorized } from './response';

export interface AuthResult {
  ok: boolean;
  decision: AccessDecision;
  response: Response | null;
}

function toAuthResult(decision: AccessDecision): AuthResult {
  return {
    ok: decision.ok,
    decision,
    response: decision.ok ? null : unauthorized(decision.error ?? 'Unauthorized'),
  };
}

export function requireAdmin(request: Request, env: Env): AuthResult {
  return toAuthResult(ensureAdminAccess(request, env));
}

export function requireAgentic(request: Request, env: Env): AuthResult {
  return toAuthResult(ensureAgenticAccess(request, env));
}

export function requireSystem(request: Request, env: Env, source?: string): AuthResult {
  return toAuthResult(ensureSystemAccess(request, env, source));
}

export async function requireUser(request: Request, env: Env): Promise<AuthResult> {
  return toAuthResult(await ensureUserAccess(request, env));
}

export function requireWebhook(request: Request, env: Env): AuthResult {
  return toAuthResult(ensureWebhookAccess(request, env));
}
