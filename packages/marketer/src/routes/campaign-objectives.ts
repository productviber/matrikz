import type {
  CampaignObjectiveRow,
  CampaignObjectiveStatus,
  CampaignObjectiveType,
  CampaignObjectiveUrgency,
  Env,
} from '../types';
import { created, json, notFound, ok, serverError, badRequest } from '../lib/response';
import { execute, query, queryOne, now } from '../lib/db';
import {
  CAMPAIGN_OBJECTIVE_STATUS,
  CAMPAIGN_OBJECTIVE_TYPE,
  CAMPAIGN_OBJECTIVE_URGENCY,
  MAX_LENGTH,
  MESSAGES,
  PAGINATION,
} from '../constants';

export interface CampaignObjectiveInput {
  objectiveType: CampaignObjectiveType;
  campaignName: string;
  businessGoalStatement: string;
  urgency: CampaignObjectiveUrgency;
  successMetricPrimary: string;
  successMetricSecondary: string | null;
  startAt: string;
  endAt: string;
  timezone: string;
  dryRun: boolean;
}

export interface CampaignObjectiveRecord extends CampaignObjectiveInput {
  id: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  status: CampaignObjectiveStatus;
}

export interface CampaignObjectiveValidationResult {
  value: CampaignObjectiveInput | null;
  fieldErrors: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asOptionalTrimmedString(value: unknown): string | null {
  const trimmed = asTrimmedString(value);
  return trimmed ? trimmed : null;
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function isEnumValue<T extends readonly string[]>(values: T, candidate: string): candidate is T[number] {
  return values.includes(candidate);
}

function epochToIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

function resolveCreatedBy(request: Request): string {
  const headerCandidate =
    request.headers.get('x-admin-user')
    ?? request.headers.get('cf-access-authenticated-user-email')
    ?? request.headers.get('x-user-email')
    ?? '';
  const createdBy = headerCandidate.trim();
  return createdBy || 'admin:ui';
}

function createObjectiveId(): string {
  return `obj_${crypto.randomUUID().replace(/-/g, '')}`.slice(0, MAX_LENGTH.CAMPAIGN_OBJECTIVE_ID);
}

function mapObjectiveRow(row: CampaignObjectiveRow): CampaignObjectiveRecord {
  return {
    id: row.id,
    objectiveType: row.objective_type,
    campaignName: row.campaign_name,
    businessGoalStatement: row.business_goal_statement,
    urgency: row.urgency,
    successMetricPrimary: row.success_metric_primary,
    successMetricSecondary: row.success_metric_secondary,
    startAt: row.start_at,
    endAt: row.end_at,
    timezone: row.timezone,
    dryRun: row.dry_run === 1,
    createdBy: row.created_by,
    createdAt: epochToIso(row.created_at),
    updatedAt: epochToIso(row.updated_at),
    status: row.status,
  };
}

export function validateCampaignObjectiveInput(payload: unknown): CampaignObjectiveValidationResult {
  if (!isRecord(payload)) {
    return {
      value: null,
      fieldErrors: { form: MESSAGES.errors.invalidCampaignObjectivePayload },
    };
  }

  const objectiveType = asTrimmedString(payload.objectiveType);
  const campaignName = asTrimmedString(payload.campaignName);
  const businessGoalStatement = asTrimmedString(payload.businessGoalStatement);
  const urgency = asTrimmedString(payload.urgency);
  const successMetricPrimary = asTrimmedString(payload.successMetricPrimary);
  const successMetricSecondary = asOptionalTrimmedString(payload.successMetricSecondary);
  const startAt = asTrimmedString(payload.startAt);
  const endAt = asTrimmedString(payload.endAt);
  const timezone = asTrimmedString(payload.timezone);
  const dryRun = toBoolean(payload.dryRun);

  const fieldErrors: Record<string, string> = {};

  if (!isEnumValue(CAMPAIGN_OBJECTIVE_TYPE, objectiveType)) {
    fieldErrors.objectiveType = 'Choose a valid objective type.';
  }
  if (!campaignName) {
    fieldErrors.campaignName = 'Campaign name is required.';
  } else if (campaignName.length > MAX_LENGTH.CAMPAIGN_OBJECTIVE_NAME) {
    fieldErrors.campaignName = `Campaign name must be ${MAX_LENGTH.CAMPAIGN_OBJECTIVE_NAME} characters or fewer.`;
  }
  if (!businessGoalStatement) {
    fieldErrors.businessGoalStatement = 'Business goal statement is required.';
  } else if (businessGoalStatement.length > MAX_LENGTH.CAMPAIGN_OBJECTIVE_GOAL_STATEMENT) {
    fieldErrors.businessGoalStatement = `Business goal statement must be ${MAX_LENGTH.CAMPAIGN_OBJECTIVE_GOAL_STATEMENT} characters or fewer.`;
  }
  if (!isEnumValue(CAMPAIGN_OBJECTIVE_URGENCY, urgency)) {
    fieldErrors.urgency = 'Choose a valid urgency.';
  }
  if (!successMetricPrimary) {
    fieldErrors.successMetricPrimary = 'Primary success metric is required.';
  } else if (successMetricPrimary.length > MAX_LENGTH.CAMPAIGN_OBJECTIVE_METRIC) {
    fieldErrors.successMetricPrimary = `Primary success metric must be ${MAX_LENGTH.CAMPAIGN_OBJECTIVE_METRIC} characters or fewer.`;
  }
  if (successMetricSecondary && successMetricSecondary.length > MAX_LENGTH.CAMPAIGN_OBJECTIVE_METRIC) {
    fieldErrors.successMetricSecondary = `Secondary success metric must be ${MAX_LENGTH.CAMPAIGN_OBJECTIVE_METRIC} characters or fewer.`;
  }
  if (!startAt || Number.isNaN(Date.parse(startAt))) {
    fieldErrors.startAt = 'Start time must be a valid datetime.';
  }
  if (!endAt || Number.isNaN(Date.parse(endAt))) {
    fieldErrors.endAt = 'End time must be a valid datetime.';
  }
  if (!fieldErrors.startAt && !fieldErrors.endAt && Date.parse(endAt) <= Date.parse(startAt)) {
    fieldErrors.endAt = 'End time must be after start time.';
  }
  if (!timezone) {
    fieldErrors.timezone = 'Timezone is required.';
  } else if (timezone.length > MAX_LENGTH.CAMPAIGN_OBJECTIVE_TIMEZONE) {
    fieldErrors.timezone = `Timezone must be ${MAX_LENGTH.CAMPAIGN_OBJECTIVE_TIMEZONE} characters or fewer.`;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { value: null, fieldErrors };
  }

  const typedObjectiveType = objectiveType as CampaignObjectiveType;
  const typedUrgency = urgency as CampaignObjectiveUrgency;

  return {
    value: {
      objectiveType: typedObjectiveType,
      campaignName,
      businessGoalStatement,
      urgency: typedUrgency,
      successMetricPrimary,
      successMetricSecondary,
      startAt,
      endAt,
      timezone,
      dryRun,
    },
    fieldErrors: {},
  };
}

function validationErrorResponse(fieldErrors: Record<string, string>): Response {
  return json({
    ok: false,
    error: MESSAGES.errors.invalidCampaignObjectivePayload,
    code: 'bad_request',
    data: { fieldErrors },
  }, 400);
}

export async function handleCreateCampaignObjective(request: Request, env: Env): Promise<Response> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return badRequest(MESSAGES.errors.invalidJson);
  }

  const { value, fieldErrors } = validateCampaignObjectiveInput(body);
  if (!value) {
    return validationErrorResponse(fieldErrors);
  }

  const id = createObjectiveId();
  const createdAt = now();
  const createdBy = resolveCreatedBy(request);

  try {
    await execute(
      env.DB,
      `INSERT INTO campaign_objectives (
        id,
        objective_type,
        campaign_name,
        business_goal_statement,
        urgency,
        success_metric_primary,
        success_metric_secondary,
        start_at,
        end_at,
        timezone,
        dry_run,
        created_by,
        created_at,
        updated_at,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        value.objectiveType,
        value.campaignName,
        value.businessGoalStatement,
        value.urgency,
        value.successMetricPrimary,
        value.successMetricSecondary,
        value.startAt,
        value.endAt,
        value.timezone,
        value.dryRun ? 1 : 0,
        createdBy,
        createdAt,
        createdAt,
        'draft',
      ],
    );

    const row = await queryOne<CampaignObjectiveRow>(
      env.DB,
      `SELECT * FROM campaign_objectives WHERE id = ?`,
      [id],
    );

    if (!row) {
      return serverError(MESSAGES.errors.failedCreateCampaignObjective);
    }

    return created({
      objective: mapObjectiveRow(row),
      message: MESSAGES.success.campaignObjectiveCreated,
    });
  } catch (err) {
    console.error('[CampaignObjective:Create] Error:', err);
    return serverError(MESSAGES.errors.failedCreateCampaignObjective);
  }
}

export async function handleListCampaignObjectives(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const status = url.searchParams.get('status')?.trim() ?? null;

  if (status && !isEnumValue(CAMPAIGN_OBJECTIVE_STATUS, status)) {
    return badRequest(MESSAGES.errors.invalidCampaignObjectiveStatus);
  }

  try {
    const params: unknown[] = [];
    let sql = `SELECT * FROM campaign_objectives`;

    if (status) {
      sql += ` WHERE status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY updated_at DESC LIMIT ?`;
    params.push(PAGINATION.DEFAULT_PAGE_SIZE);

    const objectives = await query<CampaignObjectiveRow>(env.DB, sql, params);
    return ok({
      objectives: objectives.map(mapObjectiveRow),
      filter: { status },
    });
  } catch (err) {
    console.error('[CampaignObjective:List] Error:', err);
    return serverError(MESSAGES.errors.failedListCampaignObjectives);
  }
}

export async function handleGetCampaignObjective(
  _request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  try {
    const row = await queryOne<CampaignObjectiveRow>(
      env.DB,
      `SELECT * FROM campaign_objectives WHERE id = ?`,
      [id],
    );

    if (!row) {
      return notFound(MESSAGES.errors.campaignObjectiveNotFound);
    }

    return ok({ objective: mapObjectiveRow(row) });
  } catch (err) {
    console.error('[CampaignObjective:Get] Error:', err);
    return serverError(MESSAGES.errors.failedGetCampaignObjective);
  }
}

function screenHtml(): string {
  const objectiveTypes = JSON.stringify(CAMPAIGN_OBJECTIVE_TYPE);
  const urgencies = JSON.stringify(CAMPAIGN_OBJECTIVE_URGENCY);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Campaign Objective | Visibility Marketing</title>
    <style>
      :root {
        --bg: #f5f0e8;
        --panel: #fffdf8;
        --panel-alt: #f0ebe2;
        --ink: #172027;
        --muted: #5d6670;
        --accent: #0f766e;
        --accent-strong: #115e59;
        --danger: #b42318;
        --warning: #b54708;
        --border: #d9d0c2;
        --shadow: 0 18px 40px rgba(23, 32, 39, 0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        background:
          radial-gradient(circle at top left, rgba(15, 118, 110, 0.15), transparent 30%),
          linear-gradient(180deg, #faf5ee 0%, var(--bg) 100%);
        color: var(--ink);
      }
      .shell {
        max-width: 1220px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      .hero {
        display: grid;
        gap: 16px;
        margin-bottom: 28px;
      }
      .eyebrow {
        letter-spacing: 0.12em;
        text-transform: uppercase;
        font-size: 12px;
        color: var(--accent-strong);
        font-family: "Trebuchet MS", Verdana, sans-serif;
      }
      .hero h1 {
        margin: 0;
        font-size: clamp(32px, 6vw, 56px);
        line-height: 0.95;
      }
      .hero p {
        margin: 0;
        max-width: 720px;
        color: var(--muted);
        font-size: 18px;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1.25fr) minmax(320px, 0.85fr);
        gap: 24px;
      }
      .panel {
        background: rgba(255, 253, 248, 0.94);
        border: 1px solid var(--border);
        border-radius: 24px;
        box-shadow: var(--shadow);
        overflow: hidden;
      }
      .panel-header {
        padding: 20px 22px 12px;
        border-bottom: 1px solid rgba(217, 208, 194, 0.8);
      }
      .panel-header h2, .panel-header h3 {
        margin: 0 0 6px;
        font-size: 24px;
      }
      .panel-header p {
        margin: 0;
        color: var(--muted);
        font-size: 15px;
      }
      form {
        padding: 20px 22px 24px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
      }
      .field, .full {
        display: grid;
        gap: 8px;
      }
      .full { grid-column: 1 / -1; }
      label {
        font-family: "Trebuchet MS", Verdana, sans-serif;
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      input, select, textarea {
        width: 100%;
        border: 1px solid var(--border);
        background: var(--panel);
        border-radius: 14px;
        padding: 12px 14px;
        color: var(--ink);
        font-size: 15px;
        font-family: system-ui, sans-serif;
      }
      textarea {
        min-height: 140px;
        resize: vertical;
      }
      .hint {
        min-height: 18px;
        color: var(--muted);
        font-size: 13px;
        font-family: system-ui, sans-serif;
      }
      .hint.error { color: var(--danger); }
      .switch {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px;
        border-radius: 16px;
        background: var(--panel-alt);
      }
      .switch input { width: auto; }
      .actions {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
        margin-top: 20px;
      }
      button {
        appearance: none;
        border: none;
        border-radius: 999px;
        padding: 12px 18px;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
      }
      .primary {
        background: var(--accent);
        color: white;
      }
      .secondary {
        background: #e7ded2;
        color: var(--ink);
      }
      .ghost {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--ink);
      }
      .status-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        font-family: system-ui, sans-serif;
        color: var(--muted);
        font-size: 13px;
      }
      .toast, .network, .empty {
        margin: 18px 22px 0;
        padding: 14px 16px;
        border-radius: 16px;
        font-family: system-ui, sans-serif;
        display: none;
      }
      .toast.visible, .network.visible, .empty.visible { display: block; }
      .toast { background: rgba(15, 118, 110, 0.12); color: var(--accent-strong); }
      .network { background: rgba(181, 71, 8, 0.1); color: var(--warning); }
      .preview, .list {
        padding: 20px 22px 24px;
      }
      .summary-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .summary-card {
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 14px 16px;
        background: linear-gradient(180deg, rgba(255,255,255,0.92), rgba(240,235,226,0.85));
        font-family: system-ui, sans-serif;
      }
      .summary-card strong {
        display: block;
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--muted);
        margin-bottom: 6px;
      }
      .summary-card span {
        font-size: 17px;
      }
      details {
        border: 1px solid var(--border);
        border-radius: 18px;
        background: rgba(240, 235, 226, 0.6);
        padding: 14px 16px;
      }
      summary {
        cursor: pointer;
        font-family: system-ui, sans-serif;
        font-weight: 700;
      }
      .detail-copy {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 14px;
        font-family: system-ui, sans-serif;
      }
      pre {
        margin: 0;
        background: #141e24;
        color: #dce6ea;
        padding: 18px;
        border-radius: 18px;
        overflow: auto;
        font-size: 13px;
        line-height: 1.5;
        font-family: Consolas, Monaco, monospace;
      }
      .list {
        display: grid;
        gap: 12px;
      }
      .objective-card {
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 16px;
        background: linear-gradient(180deg, rgba(255,255,255,0.92), rgba(240,235,226,0.92));
        font-family: system-ui, sans-serif;
      }
      .objective-card.pending {
        border-style: dashed;
        opacity: 0.78;
      }
      .objective-card h4 {
        margin: 0 0 8px;
        font-size: 18px;
      }
      .meta {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      @media (max-width: 980px) {
        .layout { grid-template-columns: 1fr; }
      }
      @media (max-width: 720px) {
        .grid { grid-template-columns: 1fr; }
        .shell { padding-inline: 14px; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="hero">
        <div class="eyebrow">Visibility-Marketing / Campaign Objective</div>
        <h1>Set a clear campaign goal in one pass.</h1>
        <p>Define the outcome, timing, and success measures first. The system can handle the structure in the background.</p>
      </section>

      <div class="layout">
        <section class="panel">
          <div class="panel-header">
            <h2>Plan Basics</h2>
            <p>Fill in the essentials for this campaign. Validation runs quietly as you go and the draft is saved when you are ready.</p>
          </div>
          <div id="toast" class="toast" role="status" aria-live="polite"></div>
          <div id="networkError" class="network" role="alert">
            <div id="networkMessage"></div>
            <div class="actions"><button id="retryButton" type="button" class="secondary">Retry last request</button></div>
          </div>
          <form id="objectiveForm" novalidate>
            <div class="grid">
              <div class="field">
                <label for="objectiveType">Objective Type</label>
                <select id="objectiveType" name="objectiveType"></select>
                <div class="hint" data-error-for="objectiveType"></div>
              </div>
              <div class="field">
                <label for="urgency">Urgency</label>
                <select id="urgency" name="urgency"></select>
                <div class="hint" data-error-for="urgency"></div>
              </div>
              <div class="full">
                <label for="campaignName">Campaign Name</label>
                <input id="campaignName" name="campaignName" maxlength="80" placeholder="Q2 reactivation sprint" />
                <div class="hint" data-error-for="campaignName">Maximum 80 characters.</div>
              </div>
              <div class="full">
                <label for="businessGoalStatement">What outcome are you trying to create?</label>
                <textarea id="businessGoalStatement" name="businessGoalStatement" maxlength="500" placeholder="Recover dormant trial users who reached onboarding but never activated a second session."></textarea>
                <div class="hint" data-error-for="businessGoalStatement">Maximum 500 characters.</div>
              </div>
              <div class="field">
                <label for="successMetricPrimary">Main success measure</label>
                <input id="successMetricPrimary" name="successMetricPrimary" maxlength="120" placeholder="Reactivated users within 14 days" />
                <div class="hint" data-error-for="successMetricPrimary"></div>
              </div>
              <div class="field">
                <label for="successMetricSecondary">Backup success measure</label>
                <input id="successMetricSecondary" name="successMetricSecondary" maxlength="120" placeholder="Optional" />
                <div class="hint" data-error-for="successMetricSecondary"></div>
              </div>
              <div class="field">
                <label for="startAt">Start At</label>
                <input id="startAt" name="startAt" type="datetime-local" />
                <div class="hint" data-error-for="startAt"></div>
              </div>
              <div class="field">
                <label for="endAt">End At</label>
                <input id="endAt" name="endAt" type="datetime-local" />
                <div class="hint" data-error-for="endAt"></div>
              </div>
              <div class="field">
                <label for="timezone">Timezone</label>
                <input id="timezone" name="timezone" value="UTC" maxlength="64" placeholder="UTC" />
                <div class="hint" data-error-for="timezone"></div>
              </div>
              <div class="field">
                <label>Test mode</label>
                <div class="switch">
                  <input id="dryRun" name="dryRun" type="checkbox" />
                  <span>Check the plan without triggering downstream actions.</span>
                </div>
                <div class="hint" data-error-for="dryRun"></div>
              </div>
            </div>
            <div class="actions">
              <button id="submitButton" type="submit" class="primary">Save Campaign Goal</button>
              <button id="resetButton" type="button" class="ghost">Reset</button>
            </div>
            <div class="status-row">
              <span id="submitState">Idle</span>
              <span>The draft label is applied automatically when you save.</span>
            </div>
          </form>
        </section>

        <div style="display:grid;gap:24px;align-content:start;">
          <section class="panel">
            <div class="panel-header">
              <h3>What This Plan Says</h3>
              <p>A quick summary of the campaign you are shaping before you save it.</p>
            </div>
            <div class="preview" style="display:grid;gap:14px;">
              <div class="summary-grid">
                <div class="summary-card"><strong>Campaign</strong><span id="summaryName">Not named yet</span></div>
                <div class="summary-card"><strong>Priority</strong><span id="summaryUrgency">Normal</span></div>
                <div class="summary-card"><strong>Primary measure</strong><span id="summaryMetric">Choose a measure</span></div>
                <div class="summary-card"><strong>Schedule</strong><span id="summaryWindow">Add start and end times</span></div>
              </div>
              <details>
                <summary>Show technical details</summary>
                <p class="detail-copy">This is the worker payload for debugging and parity checks.</p>
                <pre id="payloadPreview"></pre>
              </details>
            </div>
          </section>
          <section class="panel">
            <div class="panel-header">
              <h3>Recent Objectives</h3>
              <p>Recent campaign goals already saved in this environment.</p>
            </div>
            <div id="emptyState" class="empty visible">No objectives loaded yet.</div>
            <div id="objectiveList" class="list"></div>
          </section>
        </div>
      </div>
    </div>

    <script>
      const OBJECTIVE_TYPES = ${objectiveTypes};
      const URGENCIES = ${urgencies};
      const state = {
        lastFailedPayload: null,
      };

      const form = document.getElementById('objectiveForm');
      const preview = document.getElementById('payloadPreview');
      const submitButton = document.getElementById('submitButton');
      const submitState = document.getElementById('submitState');
      const toast = document.getElementById('toast');
      const networkError = document.getElementById('networkError');
      const networkMessage = document.getElementById('networkMessage');
      const retryButton = document.getElementById('retryButton');
      const resetButton = document.getElementById('resetButton');
      const objectiveList = document.getElementById('objectiveList');
      const emptyState = document.getElementById('emptyState');
      const summaryName = document.getElementById('summaryName');
      const summaryUrgency = document.getElementById('summaryUrgency');
      const summaryMetric = document.getElementById('summaryMetric');
      const summaryWindow = document.getElementById('summaryWindow');

      function fillSelect(id, values) {
        const element = document.getElementById(id);
        element.innerHTML = values.map((value) => '<option value="' + value + '">' + value + '</option>').join('');
      }

      function parseDateTimeLocal(value) {
        return value ? new Date(value).toISOString() : '';
      }

      function buildPayload() {
        const formData = new FormData(form);
        return {
          objectiveType: String(formData.get('objectiveType') || '').trim(),
          campaignName: String(formData.get('campaignName') || '').trim(),
          businessGoalStatement: String(formData.get('businessGoalStatement') || '').trim(),
          urgency: String(formData.get('urgency') || '').trim(),
          successMetricPrimary: String(formData.get('successMetricPrimary') || '').trim(),
          successMetricSecondary: String(formData.get('successMetricSecondary') || '').trim() || null,
          startAt: parseDateTimeLocal(String(formData.get('startAt') || '').trim()),
          endAt: parseDateTimeLocal(String(formData.get('endAt') || '').trim()),
          timezone: String(formData.get('timezone') || '').trim(),
          dryRun: Boolean(formData.get('dryRun')),
        };
      }

      function validate(payload) {
        const errors = {};
        if (!OBJECTIVE_TYPES.includes(payload.objectiveType)) errors.objectiveType = 'Choose a valid objective type.';
        if (!payload.campaignName) errors.campaignName = 'Campaign name is required.';
        else if (payload.campaignName.length > 80) errors.campaignName = 'Campaign name must be 80 characters or fewer.';
        if (!payload.businessGoalStatement) errors.businessGoalStatement = 'Business goal statement is required.';
        else if (payload.businessGoalStatement.length > 500) errors.businessGoalStatement = 'Business goal statement must be 500 characters or fewer.';
        if (!URGENCIES.includes(payload.urgency)) errors.urgency = 'Choose a valid urgency.';
        if (!payload.successMetricPrimary) errors.successMetricPrimary = 'Primary success metric is required.';
        if (payload.successMetricSecondary && payload.successMetricSecondary.length > 120) errors.successMetricSecondary = 'Secondary success metric must be 120 characters or fewer.';
        if (!payload.startAt || Number.isNaN(Date.parse(payload.startAt))) errors.startAt = 'Start time must be a valid datetime.';
        if (!payload.endAt || Number.isNaN(Date.parse(payload.endAt))) errors.endAt = 'End time must be a valid datetime.';
        if (!errors.startAt && !errors.endAt && Date.parse(payload.endAt) <= Date.parse(payload.startAt)) errors.endAt = 'End time must be after start time.';
        if (!payload.timezone) errors.timezone = 'Timezone is required.';
        return errors;
      }

      function setErrors(errors) {
        document.querySelectorAll('[data-error-for]').forEach((node) => {
          const key = node.getAttribute('data-error-for');
          const text = errors[key] || '';
          node.textContent = text;
          node.classList.toggle('error', Boolean(text));
        });
      }

      function formatDate(value) {
        if (!value) return '';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
      }

      function renderPreview() {
        const payload = buildPayload();
        preview.textContent = JSON.stringify(payload, null, 2);
        summaryName.textContent = payload.campaignName || 'Not named yet';
        summaryUrgency.textContent = payload.urgency ? payload.urgency[0].toUpperCase() + payload.urgency.slice(1) : 'Normal';
        summaryMetric.textContent = payload.successMetricPrimary || 'Choose a measure';
        const start = formatDate(payload.startAt);
        const end = formatDate(payload.endAt);
        summaryWindow.textContent = start && end ? start + ' to ' + end : 'Add start and end times';
      }

      function showToast(message) {
        toast.textContent = message;
        toast.classList.add('visible');
        window.clearTimeout(showToast.timeoutId);
        showToast.timeoutId = window.setTimeout(() => toast.classList.remove('visible'), 3200);
      }

      function showNetworkError(message, payload) {
        state.lastFailedPayload = payload;
        networkMessage.textContent = message;
        networkError.classList.add('visible');
      }

      function clearNetworkError() {
        state.lastFailedPayload = null;
        networkError.classList.remove('visible');
      }

      function upsertObjectiveCard(objective, pending) {
        const elementId = 'objective-' + objective.id;
        let card = document.getElementById(elementId);
        if (!card) {
          card = document.createElement('article');
          card.id = elementId;
          card.className = 'objective-card';
          objectiveList.prepend(card);
        }
        card.classList.toggle('pending', Boolean(pending));
        card.innerHTML = [
          '<h4>' + objective.campaignName + '</h4>',
          '<div class="meta">',
          '<span>' + objective.objectiveType + '</span>',
          '<span>' + objective.urgency + '</span>',
          '<span>' + objective.status + '</span>',
          pending ? '<span>saving…</span>' : '<span>' + objective.createdAt + '</span>',
          '</div>',
          '<p>' + objective.businessGoalStatement + '</p>',
          '<p><strong>Primary metric:</strong> ' + objective.successMetricPrimary + '</p>',
        ].join('');
        emptyState.classList.toggle('visible', objectiveList.children.length === 0);
      }

      async function loadObjectives() {
        try {
          const response = await fetch('/api/campaigns/objectives');
          if (!response.ok) return;
          const body = await response.json();
          objectiveList.innerHTML = '';
          const objectives = (body.data && body.data.objectives) || [];
          objectives.forEach((entry) => upsertObjectiveCard(entry, false));
          emptyState.classList.toggle('visible', objectives.length === 0);
        } catch {
          emptyState.textContent = 'Unable to load objectives from the worker right now.';
          emptyState.classList.add('visible');
        }
      }

      async function submitPayload(payload) {
        submitButton.disabled = true;
        submitState.textContent = 'Submitting…';
        clearNetworkError();

        const optimistic = {
          ...payload,
          id: 'optimistic',
          createdBy: 'admin:ui',
          createdAt: 'pending',
          updatedAt: 'pending',
          status: 'draft',
        };
        upsertObjectiveCard(optimistic, true);

        try {
          const response = await fetch('/api/campaigns/objectives', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

          const body = await response.json().catch(() => ({}));
          if (!response.ok) {
            const fieldErrors = body.data && body.data.fieldErrors ? body.data.fieldErrors : {};
            setErrors(fieldErrors);
            if (response.status >= 500) {
              showNetworkError('The worker could not persist this objective. Review the payload and retry.', payload);
            }
            document.getElementById('objective-optimistic')?.remove();
            emptyState.classList.toggle('visible', objectiveList.children.length === 0);
            submitState.textContent = 'Fix validation errors';
            return;
          }

          setErrors({});
          const objective = body.data && body.data.objective ? body.data.objective : null;
          document.getElementById('objective-optimistic')?.remove();
          if (objective) upsertObjectiveCard(objective, false);
          showToast(body.data && body.data.message ? body.data.message : 'Campaign objective created successfully.');
          submitState.textContent = 'Saved draft';
          await loadObjectives();
        } catch {
          document.getElementById('objective-optimistic')?.remove();
          emptyState.classList.toggle('visible', objectiveList.children.length === 0);
          showNetworkError('Network failure while creating the objective. Retry with the same payload.', payload);
          submitState.textContent = 'Retry available';
        } finally {
          submitButton.disabled = false;
        }
      }

      fillSelect('objectiveType', OBJECTIVE_TYPES);
      fillSelect('urgency', URGENCIES);
      renderPreview();
      loadObjectives();

      form.addEventListener('input', () => {
        renderPreview();
        setErrors(validate(buildPayload()));
      });

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const payload = buildPayload();
        const errors = validate(payload);
        setErrors(errors);
        if (Object.keys(errors).length > 0) {
          submitState.textContent = 'Fix validation errors';
          return;
        }
        await submitPayload(payload);
      });

      retryButton.addEventListener('click', async () => {
        if (!state.lastFailedPayload) return;
        await submitPayload(state.lastFailedPayload);
      });

      resetButton.addEventListener('click', () => {
        form.reset();
        document.getElementById('timezone').value = 'UTC';
        setErrors({});
        clearNetworkError();
        submitState.textContent = 'Idle';
        renderPreview();
      });
    </script>
  </body>
</html>`;
}

export async function handleCampaignObjectiveScreen(_request: Request, _env: Env): Promise<Response> {
  return new Response(screenHtml(), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}