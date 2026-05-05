import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePreviewSegment, handleSaveSegment } from '../../src/routes/campaign-segments';
import { handleGetChannelIntent, handlePutChannelIntent } from '../../src/routes/channel-intents';
import { handleSendStrategicBrief } from '../../src/routes/strategic-briefings';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';

function adminHeaders(env: MockEnv): Record<string, string> {
  return {
    Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    'x-admin-user': 'operator@visibility.test',
  };
}

describe('campaign planning routes', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('previews and saves a deterministic segment with dedupe support', async () => {
    let previewCache: any = null;
    let savedSegment: any = null;

    env.DB.onQuery(/SELECT \* FROM segment_previews WHERE segment_hash = \?/, () => (previewCache ? [previewCache] : []));
    env.DB.onQuery(/INSERT INTO segment_previews/, (params) => {
      previewCache = {
        segment_hash: params[0],
        canonical_json: params[1],
        estimate: params[2],
        confidence_band: params[3],
        last_computed_at: params[4],
      };
      return [];
    });
    env.DB.onQuery(/SELECT \* FROM campaign_segments WHERE campaign_id = \? AND segment_hash = \?/, (params) => {
      return savedSegment && savedSegment.campaign_id === params[0] && savedSegment.segment_hash === params[1] ? [savedSegment] : [];
    });
    env.DB.onQuery(/INSERT INTO campaign_segments/, (params) => {
      savedSegment = {
        id: params[0],
        campaign_id: params[1],
        segment_hash: params[2],
        canonical_json: params[3],
        include_json: params[4],
        exclude_json: params[5],
        estimate: params[6],
        contradiction_json: params[7],
        created_at: params[8],
        updated_at: params[9],
      };
      return [];
    });
    env.DB.onQuery(/SELECT \* FROM campaign_segments WHERE id = \?/, (params) => {
      return savedSegment && savedSegment.id === params[0] ? [savedSegment] : [];
    });

    const payload = {
      campaignId: 'obj_demo_retention_local',
      includeConditions: [{ field: 'language', operator: 'equals', value: 'en' }],
      excludeConditions: [{ field: 'appInstalled', operator: 'equals', value: false }],
    };

    const previewRes = await handlePreviewSegment(makeRequest('POST', '/api/segments/preview', payload, adminHeaders(env)), env as any);
    expect(previewRes.status).toBe(200);
    const previewBody = await previewRes.json() as any;
    expect(previewBody.data.segmentHash).toHaveLength(64);
    expect(previewBody.data.estimatedAudienceSize).toBeGreaterThan(0);

    const saveRes = await handleSaveSegment(makeRequest('POST', '/api/segments/save', payload, adminHeaders(env)), env as any);
    expect(saveRes.status).toBe(201);
    const saveBody = await saveRes.json() as any;
    expect(saveBody.data.segment.campaignId).toBe('obj_demo_retention_local');
    expect(saveBody.data.deduped).toBe(false);

    const dedupeRes = await handleSaveSegment(makeRequest('POST', '/api/segments/save', payload, adminHeaders(env)), env as any);
    expect(dedupeRes.status).toBe(200);
    const dedupeBody = await dedupeRes.json() as any;
    expect(dedupeBody.data.deduped).toBe(true);
  });

  it('rejects contradictory segment filters', async () => {
    const res = await handlePreviewSegment(
      makeRequest('POST', '/api/segments/preview', {
        campaignId: 'obj_demo_retention_local',
        includeConditions: [{ field: 'language', operator: 'equals', value: 'en' }],
        excludeConditions: [{ field: 'language', operator: 'equals', value: 'en' }],
      }, adminHeaders(env)),
      env as any,
    );

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.data.contradictions[0]).toContain('language both includes and excludes');
  });

  it('persists and reads channel intent with resolver preview', async () => {
    let campaignIntent: any = null;

    env.DB.onQuery(/INSERT INTO channel_intents/, (params) => {
      campaignIntent = {
        scope_type: params[0],
        scope_id: params[1],
        campaign_id: params[2],
        segment_id: params[3],
        hard_block_json: params[4],
        preferred_json: params[5],
        fallback_json: params[6],
        created_at: params[7],
        updated_at: params[8],
      };
      return [];
    });
    env.DB.onQuery(/SELECT \* FROM channel_intents WHERE scope_type = \? AND scope_id = \?/, () => (campaignIntent ? [campaignIntent] : []));
    env.DB.onQuery(/SELECT \* FROM channel_intents WHERE scope_type = 'campaign' AND scope_id = \?/, () => (campaignIntent ? [campaignIntent] : []));
    env.DB.onQuery(/SELECT \* FROM channel_intents WHERE scope_type = 'segment' AND campaign_id = \? ORDER BY updated_at DESC/, () => []);

    const putRes = await handlePutChannelIntent(
      makeRequest('PUT', '/api/campaigns/obj_demo_retention_local/channel-intent', {
        preferredChannels: ['whatsapp', 'sms'],
        hardBlockChannels: ['push'],
        fallbackChannels: ['telegram'],
        sampleAvailability: { whatsapp: true, sms: true },
      }, adminHeaders(env)),
      env as any,
      'obj_demo_retention_local',
    );

    expect(putRes.status).toBe(201);
    const putBody = await putRes.json() as any;
    expect(putBody.data.intent.profile.preferredChannels).toEqual(['whatsapp', 'sms']);
    expect(putBody.data.resolverPreview.selectedChannel).toBe('whatsapp');

    const getRes = await handleGetChannelIntent(
      makeRequest('GET', '/api/campaigns/obj_demo_retention_local/channel-intent?availability=%7B%22sms%22%3Atrue%7D', undefined, adminHeaders(env)),
      env as any,
      'obj_demo_retention_local',
    );
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json() as any;
    expect(getBody.data.intent.profile.hardBlockChannels).toEqual(['push']);
    expect(getBody.data.resolverPreview.selectedChannel).toBe('sms');
  });

  it('builds, signs, and sends a strategic brief to Skrip', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(JSON.stringify({
        requestId: 'skrip_req_123',
        channelSelected: 'whatsapp',
        deliveryMode: 'strategic',
        policyAdjustments: [],
        usedFallbackTemplate: false,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    env = createMockEnv({
      SKRIP_SERVICE: { fetch: fetchSpy } as any,
      SKRIP_SERVICE_TOKEN: 'skrip-token',
      SKRIP_SIGNING_SECRET: 'skrip-secret',
    });

    env.DB.onQuery(/SELECT id, objective_type, campaign_name, business_goal_statement, urgency, dry_run FROM campaign_objectives WHERE id = \?/, () => [{
      id: 'obj_demo_retention_local',
      objective_type: 'retention',
      campaign_name: 'Lifecycle Winback',
      business_goal_statement: 'Re-activate dormant high-intent users.',
      urgency: 'high',
      dry_run: 0,
    }]);
    env.DB.onQuery(/SELECT hard_block_json, preferred_json, fallback_json FROM channel_intents WHERE scope_type = 'campaign' AND scope_id = \?/, () => [{
      hard_block_json: '[]',
      preferred_json: '["email"]',
      fallback_json: '["whatsapp","sms"]',
    }]);
    env.DB.onQuery(/INSERT INTO strategic_brief_logs/, () => []);

    const res = await handleSendStrategicBrief(
      makeRequest('POST', '/api/admin/strategic-briefings/send', {
        campaignId: 'obj_demo_retention_local',
        headline: 'Re-engage users before intent cools',
        bodyIntent: 'Follow up while trust is still present.',
        cta: 'Finish activation',
        tone: 'calm, direct, useful',
        forbiddenClaims: ['guaranteed results'],
        complianceTags: ['marketing'],
        locale: 'en',
        allowedHours: { startHour: 9, endHour: 18, timezone: 'UTC' },
        fallbackTemplateKey: 'agentic-skrip-followup',
        personalizationHints: ['plan'],
        channelPriority: ['whatsapp', 'email', 'sms'],
        strategyNonce: 'nonce_123',
      }, adminHeaders(env)),
      env as any,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.requestBody.channelPreferences).toEqual(['whatsapp', 'sms']);
    expect(body.data.responseEnvelope.channelSelected).toBe('whatsapp');
    expect(body.data.signing.signature).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const fetchInit = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((fetchInit.headers as Record<string, string>)['x-strategy-signature']).toBeTruthy();
  });
});
