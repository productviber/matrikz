import { beforeEach, describe, expect, it } from 'vitest';
import {
  handleCreateCampaignObjective,
  handleGetCampaignObjective,
  handleListCampaignObjectives,
  validateCampaignObjectiveInput,
} from '../../src/routes/campaign-objectives';
import { createMockEnv, makeRequest, type MockEnv } from '../helpers';

describe('campaign objective routes', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = createMockEnv();
  });

  function adminRequest(method: string, path: string, body?: unknown): Request {
    return makeRequest(method, path, body, {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
      'x-admin-user': 'operator@visibility.test',
    });
  }

  describe('validateCampaignObjectiveInput()', () => {
    it('returns field errors for invalid payloads', () => {
      const result = validateCampaignObjectiveInput({
        objectiveType: 'bad-value',
        campaignName: 'x'.repeat(81),
        businessGoalStatement: 'x'.repeat(501),
        urgency: 'rush',
        successMetricPrimary: '',
        startAt: '2026-05-04T10:00:00.000Z',
        endAt: '2026-05-04T09:00:00.000Z',
        timezone: '',
        dryRun: false,
      });

      expect(result.value).toBeNull();
      expect(result.fieldErrors.objectiveType).toContain('valid objective type');
      expect(result.fieldErrors.campaignName).toContain('80');
      expect(result.fieldErrors.businessGoalStatement).toContain('500');
      expect(result.fieldErrors.endAt).toContain('after start');
    });
  });

  describe('handleCreateCampaignObjective()', () => {
    it('creates an objective and returns the contract envelope', async () => {
      let inserted: any = null;
      env.DB.onQuery(/INSERT INTO campaign_objectives/, (params) => {
        inserted = {
          id: String(params[0]),
          objective_type: params[1],
          campaign_name: params[2],
          business_goal_statement: params[3],
          urgency: params[4],
          success_metric_primary: params[5],
          success_metric_secondary: params[6],
          start_at: params[7],
          end_at: params[8],
          timezone: params[9],
          dry_run: params[10],
          created_by: params[11],
          created_at: params[12],
          updated_at: params[13],
          status: params[14],
        };
        return [];
      });
      env.DB.onQuery(/SELECT \* FROM campaign_objectives WHERE id = \?/, (params) => {
        if (inserted && params[0] === inserted.id) {
          return [inserted];
        }
        return [];
      });

      const req = adminRequest('POST', '/api/campaigns/objectives', {
        objectiveType: 'retention',
        campaignName: 'Lifecycle Winback',
        businessGoalStatement: 'Bring inactive users back into weekly engagement.',
        urgency: 'medium',
        successMetricPrimary: 'Weekly active recovered users',
        successMetricSecondary: 'Reply rate',
        startAt: '2026-05-04T10:00:00.000Z',
        endAt: '2026-05-11T10:00:00.000Z',
        timezone: 'UTC',
        dryRun: true,
      });

      const res = await handleCreateCampaignObjective(req, env as any);
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.data.objective.id).toMatch(/^obj_/);
      expect(body.data.objective.status).toBe('draft');
      expect(body.data.objective.createdBy).toBe('operator@visibility.test');
      expect(body.data.message).toContain('created successfully');
    });

    it('returns validation hints when payload is invalid', async () => {
      const req = adminRequest('POST', '/api/campaigns/objectives', {
        objectiveType: 'retention',
        campaignName: 'Bad Dates',
        businessGoalStatement: 'Test objective.',
        urgency: 'medium',
        successMetricPrimary: 'Users',
        startAt: '2026-05-11T10:00:00.000Z',
        endAt: '2026-05-04T10:00:00.000Z',
        timezone: 'UTC',
        dryRun: false,
      });

      const res = await handleCreateCampaignObjective(req, env as any);
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.data.fieldErrors.endAt).toContain('after start');
    });
  });

  describe('handleListCampaignObjectives()', () => {
    it('filters by status', async () => {
      env.DB.onQuery(/SELECT \* FROM campaign_objectives WHERE status = \? ORDER BY updated_at DESC LIMIT \?/, (params) => {
        expect(params[0]).toBe('draft');
        return [
          {
            id: 'obj_demo',
            objective_type: 'activation',
            campaign_name: 'Demo',
            business_goal_statement: 'Ship demo objective.',
            urgency: 'high',
            success_metric_primary: 'Activated accounts',
            success_metric_secondary: null,
            start_at: '2026-05-04T10:00:00.000Z',
            end_at: '2026-05-05T10:00:00.000Z',
            timezone: 'UTC',
            dry_run: 0,
            created_by: 'seed',
            created_at: 1777840800,
            updated_at: 1777840800,
            status: 'draft',
          },
        ];
      });

      const res = await handleListCampaignObjectives(adminRequest('GET', '/api/campaigns/objectives?status=draft'), env as any);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.filter.status).toBe('draft');
      expect(body.data.objectives).toHaveLength(1);
    });
  });

  describe('handleGetCampaignObjective()', () => {
    it('reads a stored objective', async () => {
      env.DB.onQuery(/SELECT \* FROM campaign_objectives WHERE id = \?/, () => [
        {
          id: 'obj_read',
          objective_type: 'conversion',
          campaign_name: 'Readback',
          business_goal_statement: 'Read flow objective.',
          urgency: 'low',
          success_metric_primary: 'Converted leads',
          success_metric_secondary: null,
          start_at: '2026-05-04T10:00:00.000Z',
          end_at: '2026-05-05T10:00:00.000Z',
          timezone: 'UTC',
          dry_run: 1,
          created_by: 'seed',
          created_at: 1777840800,
          updated_at: 1777840800,
          status: 'draft',
        },
      ]);

      const res = await handleGetCampaignObjective(adminRequest('GET', '/api/campaigns/objectives/obj_read'), env as any, 'obj_read');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.objective.id).toBe('obj_read');
      expect(body.data.objective.dryRun).toBe(true);
    });
  });
});