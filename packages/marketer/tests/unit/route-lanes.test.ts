import { describe, it, expect } from 'vitest';
import { resolveRouteLane, isLaneMapped } from '../../src/lib/route-lanes';

describe('route lane resolver', () => {
  it('maps system ingress route', () => {
    expect(resolveRouteLane('POST', '/events')).toBe('system');
  });

  it('maps webhook ingress routes', () => {
    expect(resolveRouteLane('POST', '/webhooks/brevo')).toBe('webhook');
    expect(resolveRouteLane('POST', '/webhooks/brevo/inbound')).toBe('webhook');
    expect(resolveRouteLane('POST', '/webhooks/skrip/v1/outcomes')).toBe('webhook');
  });

  it('maps user self-service routes', () => {
    expect(resolveRouteLane('GET', '/api/affiliate/portal')).toBe('user');
    expect(resolveRouteLane('GET', '/api/affiliate/stats')).toBe('user');
    expect(resolveRouteLane('GET', '/api/affiliate/gdpr/export')).toBe('user');
    expect(resolveRouteLane('DELETE', '/api/affiliate/gdpr/delete')).toBe('user');
    expect(resolveRouteLane('POST', '/api/affiliate/session')).toBe('user');
    expect(resolveRouteLane('POST', '/api/unsubscribe')).toBe('user');
  });

  it('maps admin routes including dynamic campaign paths', () => {
    expect(resolveRouteLane('GET', '/api/admin/dashboard')).toBe('admin');
    expect(resolveRouteLane('POST', '/api/payouts/batch')).toBe('admin');
    expect(resolveRouteLane('GET', '/api/affiliate/AFF100/payout-details')).toBe('admin');
    expect(resolveRouteLane('GET', '/api/campaigns/my-campaign')).toBe('admin');
    expect(resolveRouteLane('PUT', '/api/campaigns/my-campaign')).toBe('admin');
    expect(resolveRouteLane('GET', '/api/health')).toBe('admin');
    expect(resolveRouteLane('POST', '/api/affiliate/approve')).toBe('admin');
    expect(resolveRouteLane('GET', '/api/affiliate/applications')).toBe('admin');
  });

  it('maps bounded agentic routes', () => {
    expect(resolveRouteLane('GET', '/api/agentic/growth-signals')).toBe('agentic');
    expect(resolveRouteLane('GET', '/api/agentic/subjects/lead%40acme.com/context')).toBe('agentic');
    expect(resolveRouteLane('POST', '/api/agentic/actions/propose')).toBe('agentic');
    expect(resolveRouteLane('POST', '/api/agentic/actions/dry-run')).toBe('agentic');
    expect(resolveRouteLane('POST', '/api/agentic/actions/execute')).toBe('agentic');
    expect(resolveRouteLane('GET', '/api/agentic/actions/act_123')).toBe('agentic');
    expect(resolveRouteLane('GET', '/api/agentic/actions/act_123/audit')).toBe('agentic');
    expect(resolveRouteLane('POST', '/api/admin/emails/process')).toBe('agentic');
    expect(resolveRouteLane('POST', '/api/admin/campaigns/outbound/12/start')).toBe('agentic');
    expect(resolveRouteLane('POST', '/api/admin/campaigns/outbound/12/pause')).toBe('agentic');
  });

  it('returns null for public routes', () => {
    expect(resolveRouteLane('GET', '/health')).toBeNull();
    expect(resolveRouteLane('GET', '/')).toBeNull();
    expect(resolveRouteLane('GET', '/r/my-referral')).toBeNull();
  });

  it('reports mapping state', () => {
    expect(isLaneMapped('POST', '/events')).toBe(true);
    expect(isLaneMapped('GET', '/health')).toBe(false);
  });
});
