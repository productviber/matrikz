import type { AccessLane } from './access';

interface RouteLaneRule {
  method: string | '*';
  match: (path: string) => boolean;
  lane: AccessLane;
}

const RULES: RouteLaneRule[] = [
  // System ingress
  { method: 'POST', match: (path) => path === '/events', lane: 'system' },

  // Webhook ingress
  { method: 'POST', match: (path) => path === '/webhooks/brevo', lane: 'webhook' },
  { method: 'POST', match: (path) => path === '/webhooks/brevo/inbound', lane: 'webhook' },

  // Agentic lane (proposed and explicitly bounded)
  { method: 'POST', match: (path) => path === '/api/admin/emails/process', lane: 'agentic' },
  {
    method: 'POST',
    match: (path) => /^\/api\/admin\/campaigns\/outbound\/\d+\/(start|pause)$/.test(path),
    lane: 'agentic',
  },

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
