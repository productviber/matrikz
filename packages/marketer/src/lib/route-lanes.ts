import type { AccessLane } from './access';

interface RouteLaneRule {
  method: string | '*';
  match: (path: string) => boolean;
  lane: AccessLane;
}

/**
 * Explicit allowlist of operations permitted in the agentic lane.
 * Any request presenting agent credentials MUST match one of these.
 * Used both for RULES wiring and as a named constant for audits/docs.
 */
export const AGENTIC_ALLOWED_OPERATIONS: ReadonlyArray<{ method: string; description: string }> = [
  { method: 'GET /api/agentic/growth-signals', description: 'List eligible growth signals' },
  { method: 'GET /api/agentic/subjects/:id/context', description: 'Read growth subject context' },
  { method: 'POST /api/agentic/actions/propose', description: 'Create a ledgered agent action proposal' },
  { method: 'POST /api/agentic/actions/dry-run', description: 'Run policy checks without execution' },
  { method: 'POST /api/agentic/actions/execute', description: 'Execute an approved low-risk agent action' },
  { method: 'GET /api/agentic/actions/:id', description: 'Read agent action state' },
  { method: 'GET /api/agentic/actions/:id/audit', description: 'Read agent action audit events' },
  { method: 'GET /api/agentic/actions/:id/trace', description: 'Read agent action execution trace and Skrip lineage' },
  { method: 'POST /api/admin/emails/process', description: 'Trigger due-email processing batch' },
  { method: 'POST /api/admin/campaigns/outbound/:id/start', description: 'Start outbound campaign' },
  { method: 'POST /api/admin/campaigns/outbound/:id/pause', description: 'Pause outbound campaign' },
] as const;

const RULES: RouteLaneRule[] = [
  // System ingress
  { method: 'POST', match: (path) => path === '/events', lane: 'system' },
  // Internal service-to-service endpoints (analytics worker → marketing worker)
  // Auth: CF service-binding header OR x-system-token / SYSTEM_TOKEN.
  { method: '*', match: (path) => path.startsWith('/api/internal/'), lane: 'system' },
  // Closed-loop ingress and operator metrics.
  { method: 'POST', match: (path) => path === '/dispatch', lane: 'system' },
  { method: 'GET', match: (path) => path.startsWith('/metrics/'), lane: 'system' },

  // Webhook ingress
  { method: 'POST', match: (path) => path === '/webhooks/brevo', lane: 'webhook' },
  { method: 'POST', match: (path) => path === '/webhooks/brevo/inbound', lane: 'webhook' },
  { method: 'POST', match: (path) => path === '/webhooks/skrip/v1/outcomes', lane: 'webhook' },

  // Skrip push subscription (public user-facing — no auth, rate-limited at handler)
  { method: 'POST', match: (path) => path === '/api/push/subscribe', lane: 'user' },
  { method: 'DELETE', match: (path) => path === '/api/push/unsubscribe', lane: 'user' },
  { method: 'POST', match: (path) => path === '/api/push/receipt', lane: 'user' },
  { method: 'GET', match: (path) => path.startsWith('/api/push/status/'), lane: 'user' },

  // Skrip multi-channel subscriptions (WhatsApp, SMS, Telegram — user lane)
  { method: 'POST', match: (path) => path === '/api/channels/whatsapp/subscribe', lane: 'user' },
  { method: 'DELETE', match: (path) => path === '/api/channels/whatsapp/unsubscribe', lane: 'user' },
  { method: 'POST', match: (path) => path === '/api/channels/sms/subscribe', lane: 'user' },
  { method: 'DELETE', match: (path) => path === '/api/channels/sms/unsubscribe', lane: 'user' },
  { method: 'POST', match: (path) => path === '/api/channels/telegram/subscribe', lane: 'user' },
  { method: 'DELETE', match: (path) => path === '/api/channels/telegram/unsubscribe', lane: 'user' },

  // Agentic lane (proposed and explicitly bounded)
  { method: '*', match: (path) => path.startsWith('/api/agentic/'), lane: 'agentic' },
  { method: 'POST', match: (path) => path === '/api/admin/emails/process', lane: 'agentic' },
  {
    method: 'POST',
    match: (path) => /^\/api\/admin\/campaigns\/outbound\/\d+\/(start|pause)$/.test(path),
    lane: 'agentic',
  },

  // Identity token (admin lane: mint; system lane: verify)
  { method: 'POST', match: (path) => path === '/api/identity/mint', lane: 'admin' },
  { method: 'POST', match: (path) => path === '/api/identity/verify', lane: 'system' },

  // Admin surfaces
  { method: 'GET', match: (path) => path === '/api/health', lane: 'admin' },
  { method: 'POST', match: (path) => path === '/api/affiliate/approve', lane: 'admin' },
  { method: 'GET', match: (path) => path === '/api/affiliate/applications', lane: 'admin' },
  { method: '*', match: (path) => path.startsWith('/api/admin/'), lane: 'admin' },
  { method: '*', match: (path) => path.startsWith('/api/payouts'), lane: 'admin' },
  { method: '*', match: (path) => /^\/api\/affiliate\/[^/]+\/payout-details$/.test(path), lane: 'admin' },

  // Campaign management APIs are admin-owned in this worker.
  { method: 'POST', match: (path) => path === '/api/campaigns', lane: 'admin' },
  { method: 'GET', match: (path) => path === '/api/campaigns', lane: 'admin' },
  { method: 'POST', match: (path) => path === '/api/campaigns/objectives', lane: 'admin' },
  { method: 'GET', match: (path) => path === '/api/campaigns/objectives', lane: 'admin' },
  { method: 'GET', match: (path) => /^\/api\/campaigns\/objectives\/[^/]+$/.test(path), lane: 'admin' },
  { method: 'POST', match: (path) => path === '/api/segments/preview', lane: 'admin' },
  { method: 'POST', match: (path) => path === '/api/segments/save', lane: 'admin' },
  { method: 'GET', match: (path) => path === '/api/segments', lane: 'admin' },
  { method: 'GET', match: (path) => /^\/api\/segments\/[^/]+$/.test(path), lane: 'admin' },
  { method: 'GET', match: (path) => /^\/api\/campaigns\/[^/]+\/channel-intent$/.test(path), lane: 'admin' },
  { method: 'PUT', match: (path) => /^\/api\/campaigns\/[^/]+\/channel-intent$/.test(path), lane: 'admin' },
  { method: 'GET', match: (path) => /^\/api\/campaigns\/[^/]+$/.test(path), lane: 'admin' },
  { method: 'PUT', match: (path) => /^\/api\/campaigns\/[^/]+$/.test(path), lane: 'admin' },

  // User-owned self-service surfaces
  { method: 'GET', match: (path) => path === '/api/affiliate/portal', lane: 'user' },
  { method: 'GET', match: (path) => path === '/api/affiliate/stats', lane: 'user' },
  { method: 'GET', match: (path) => path === '/api/affiliate/gdpr/export', lane: 'user' },
  { method: 'DELETE', match: (path) => path === '/api/affiliate/gdpr/delete', lane: 'user' },
  { method: 'POST', match: (path) => path === '/api/affiliate/session', lane: 'user' },
  { method: 'POST', match: (path) => path === '/api/unsubscribe', lane: 'user' },
];

export function resolveRouteLane(method: string, path: string): AccessLane | null {
  for (const rule of RULES) {
    if (rule.method !== '*' && rule.method !== method) {
      continue;
    }
    if (rule.match(path)) {
      return rule.lane;
    }
  }
  return null;
}

export function isLaneMapped(method: string, path: string): boolean {
  return resolveRouteLane(method, path) !== null;
}

export function getRouteLaneRules(): ReadonlyArray<RouteLaneRule> {
  return RULES;
}
