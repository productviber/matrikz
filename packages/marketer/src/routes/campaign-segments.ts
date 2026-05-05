import type { Env } from '../types';
import { created, json, notFound, ok, serverError, badRequest } from '../lib/response';
import { execute, now, query, queryOne } from '../lib/db';
import {
  computeSegmentHash,
  detectSegmentContradictions,
  estimateAudienceSize,
  MAX_SEGMENT_CONDITIONS,
  parseSegmentDefinition,
  serializeSegmentDefinition,
  SEGMENT_FIELDS,
  SEGMENT_OPERATORS,
  totalSegmentConditions,
  type SegmentDefinition,
} from '../lib/campaign-planning/shared';

interface SegmentRow {
  id: string;
  campaign_id: string;
  segment_hash: string;
  canonical_json: string;
  include_json: string;
  exclude_json: string;
  estimate: number;
  contradiction_json: string;
  created_at: number;
  updated_at: number;
}

interface SegmentPreviewRow {
  segment_hash: string;
  canonical_json: string;
  estimate: number;
  confidence_band: string | null;
  last_computed_at: number;
}

interface SegmentRecord {
  id: string;
  campaignId: string;
  segmentHash: string;
  definition: SegmentDefinition;
  estimatedAudienceSize: number;
  contradictions: string[];
  createdAt: string;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

function createSegmentId(): string {
  return `seg_${crypto.randomUUID().replace(/-/g, '')}`;
}

function mapSegmentRow(row: SegmentRow): SegmentRecord {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    segmentHash: row.segment_hash,
    definition: {
      includeConditions: JSON.parse(row.include_json) as SegmentDefinition['includeConditions'],
      excludeConditions: JSON.parse(row.exclude_json) as SegmentDefinition['excludeConditions'],
    },
    estimatedAudienceSize: row.estimate,
    contradictions: JSON.parse(row.contradiction_json) as string[],
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

async function buildSegmentPreview(payload: unknown, env: Env): Promise<{
  campaignId: string;
  definition: SegmentDefinition;
  segmentHash: string;
  canonicalJson: string;
  estimatedAudienceSize: number;
  contradictions: string[];
  confidenceBand: string | null;
  lastComputedTimestamp: string;
}> {
  if (!isRecord(payload)) {
    throw new Error('Segment payload is invalid.');
  }

  const campaignId = typeof payload.campaignId === 'string' ? payload.campaignId.trim() : '';
  if (!campaignId) {
    throw new Error('campaignId is required.');
  }

  const definition = parseSegmentDefinition(payload);
  const totalConditions = totalSegmentConditions(definition);
  if (totalConditions === 0) {
    throw new Error('Add at least one include or exclude condition.');
  }
  if (totalConditions > MAX_SEGMENT_CONDITIONS) {
    throw new Error(`Segments support at most ${MAX_SEGMENT_CONDITIONS} total conditions.`);
  }

  const contradictions = detectSegmentContradictions(definition);
  if (contradictions.length > 0) {
    const error = new Error(contradictions[0]);
    (error as Error & { contradictions?: string[] }).contradictions = contradictions;
    throw error;
  }

  const segmentHash = await computeSegmentHash(definition);
  const canonicalJson = serializeSegmentDefinition(definition);
  const cached = await queryOne<SegmentPreviewRow>(
    env.DB,
    `SELECT * FROM segment_previews WHERE segment_hash = ?`,
    [segmentHash],
  );

  if (cached) {
    return {
      campaignId,
      definition,
      segmentHash,
      canonicalJson,
      estimatedAudienceSize: cached.estimate,
      contradictions: [],
      confidenceBand: cached.confidence_band,
      lastComputedTimestamp: toIso(cached.last_computed_at),
    };
  }

  const estimatedAudienceSize = estimateAudienceSize(segmentHash, totalConditions);
  const computedAt = now();
  await execute(
    env.DB,
    `INSERT INTO segment_previews (segment_hash, canonical_json, estimate, confidence_band, last_computed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(segment_hash) DO UPDATE SET
       canonical_json = excluded.canonical_json,
       estimate = excluded.estimate,
       confidence_band = excluded.confidence_band,
       last_computed_at = excluded.last_computed_at`,
    [segmentHash, canonicalJson, estimatedAudienceSize, 'stable', computedAt],
  );

  return {
    campaignId,
    definition,
    segmentHash,
    canonicalJson,
    estimatedAudienceSize,
    contradictions: [],
    confidenceBand: null,
    lastComputedTimestamp: toIso(computedAt),
  };
}

function contradictionResponse(error: Error): Response {
  const contradictions = (error as Error & { contradictions?: string[] }).contradictions ?? [error.message];
  return json(
    {
      ok: false,
      error: 'Contradictory segment filters detected.',
      code: 'bad_request',
      data: { contradictions },
    },
    400,
  );
}

export async function handlePreviewSegment(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Invalid JSON body');
  }

  try {
    const preview = await buildSegmentPreview(body, env);
    return ok({
      campaignId: preview.campaignId,
      segmentHash: preview.segmentHash,
      canonicalJson: JSON.parse(preview.canonicalJson),
      estimatedAudienceSize: preview.estimatedAudienceSize,
      confidenceBand: preview.confidenceBand,
      lastComputedTimestamp: preview.lastComputedTimestamp,
    });
  } catch (error) {
    if ((error as Error & { contradictions?: string[] }).contradictions) {
      return contradictionResponse(error as Error);
    }
    return badRequest(error instanceof Error ? error.message : String(error));
  }
}

export async function handleSaveSegment(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Invalid JSON body');
  }

  try {
    const preview = await buildSegmentPreview(body, env);
    const existing = await queryOne<SegmentRow>(
      env.DB,
      `SELECT * FROM campaign_segments WHERE campaign_id = ? AND segment_hash = ?`,
      [preview.campaignId, preview.segmentHash],
    );

    if (existing) {
      return ok({ segment: mapSegmentRow(existing), deduped: true });
    }

    const epoch = now();
    const id = createSegmentId();
    await execute(
      env.DB,
      `INSERT INTO campaign_segments (
        id,
        campaign_id,
        segment_hash,
        canonical_json,
        include_json,
        exclude_json,
        estimate,
        contradiction_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        preview.campaignId,
        preview.segmentHash,
        preview.canonicalJson,
        JSON.stringify(preview.definition.includeConditions),
        JSON.stringify(preview.definition.excludeConditions),
        preview.estimatedAudienceSize,
        JSON.stringify(preview.contradictions),
        epoch,
        epoch,
      ],
    );

    const row = await queryOne<SegmentRow>(env.DB, `SELECT * FROM campaign_segments WHERE id = ?`, [id]);
    if (!row) {
      return serverError('Failed to save segment.');
    }
    return created({ segment: mapSegmentRow(row), deduped: false });
  } catch (error) {
    if ((error as Error & { contradictions?: string[] }).contradictions) {
      return contradictionResponse(error as Error);
    }
    return badRequest(error instanceof Error ? error.message : String(error));
  }
}

export async function handleGetSegment(_request: Request, env: Env, segmentId: string): Promise<Response> {
  const row = await queryOne<SegmentRow>(env.DB, `SELECT * FROM campaign_segments WHERE id = ?`, [segmentId]);
  if (!row) {
    return notFound('Segment not found');
  }
  return ok({ segment: mapSegmentRow(row) });
}

export async function handleListSegments(request: Request, env: Env): Promise<Response> {
  try {
    const campaignId = new URL(request.url).searchParams.get('campaignId')?.trim();
    let rows: SegmentRow[];
    if (campaignId) {
      rows = await query<SegmentRow>(
        env.DB,
        `SELECT * FROM campaign_segments WHERE campaign_id = ? ORDER BY updated_at DESC`,
        [campaignId],
      );
    } else {
      rows = await query<SegmentRow>(env.DB, `SELECT * FROM campaign_segments ORDER BY updated_at DESC LIMIT 50`);
    }

    return ok({
      segments: rows.map(mapSegmentRow),
      fields: SEGMENT_FIELDS,
      operators: SEGMENT_OPERATORS,
    });
  } catch (error) {
    console.error('[Segments:List] Error:', error);
    return serverError('Failed to list segments');
  }
}

function screenHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Segment Selection | Visibility Marketing</title>
    <style>
      :root { --bg:#f7f4ef; --ink:#172027; --muted:#5f6771; --line:#d7d0c5; --accent:#0f766e; --panel:#fffdf9; --warn:#b54708; }
      * { box-sizing:border-box; }
      body { margin:0; font-family:Georgia, serif; background:linear-gradient(180deg,#faf7f2, var(--bg)); color:var(--ink); }
      .shell { max-width:1180px; margin:0 auto; padding:28px 18px 40px; }
      h1 { font-size:clamp(30px,6vw,54px); line-height:0.96; margin:0 0 10px; }
      p { color:var(--muted); }
      .layout { display:grid; grid-template-columns:1.15fr 0.85fr; gap:22px; }
      .panel { background:var(--panel); border:1px solid var(--line); border-radius:22px; overflow:hidden; box-shadow:0 12px 32px rgba(23,32,39,.08); }
      .panel h2, .panel h3 { margin:0 0 6px; }
      .head { padding:18px 20px 12px; border-bottom:1px solid var(--line); }
      .body { padding:18px 20px 22px; }
      label { display:block; font:12px/1.2 Arial, sans-serif; text-transform:uppercase; letter-spacing:.08em; margin-bottom:7px; }
      input, select { width:100%; padding:11px 12px; border:1px solid var(--line); border-radius:14px; background:white; }
      .grid { display:grid; grid-template-columns:1fr 1fr 1fr auto; gap:12px; align-items:end; }
      .stack { display:grid; gap:16px; }
      button { border:none; border-radius:999px; padding:11px 15px; cursor:pointer; font-weight:700; }
      .primary { background:var(--accent); color:white; }
      .secondary { background:#ebe4d9; color:var(--ink); }
      .ghost { background:transparent; border:1px solid var(--line); }
      .condition { border:1px solid var(--line); border-radius:16px; padding:12px; display:flex; justify-content:space-between; gap:10px; align-items:center; font-family:Arial,sans-serif; }
      .warn { background:rgba(181,71,8,.09); color:var(--warn); border-radius:16px; padding:12px; display:none; }
      .warn.visible { display:block; }
      .notice { display:none; border-radius:16px; padding:12px 14px; font:14px Arial,sans-serif; }
      .notice.visible { display:block; }
      .notice.success { background:rgba(15,118,110,.12); color:#0d625c; }
      .notice.error { background:rgba(181,71,8,.12); color:#8a3d06; }
      .rule-help { margin:0; color:var(--muted); font:14px Arial,sans-serif; }
      .summary-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
      .summary-card { border:1px solid var(--line); border-radius:16px; padding:14px; background:white; font-family:Arial,sans-serif; }
      .summary-card strong { display:block; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.05em; margin-bottom:6px; }
      details { border:1px solid var(--line); border-radius:16px; background:#f4efe7; padding:14px; }
      summary { cursor:pointer; font:700 14px Arial,sans-serif; }
      .detail-copy { margin:8px 0 0; color:var(--muted); font:13px Arial,sans-serif; }
      pre { margin:0; background:#101920; color:#dbe6ec; border-radius:16px; padding:16px; overflow:auto; font-size:13px; }
      @media (max-width: 920px) { .layout { grid-template-columns:1fr; } .grid { grid-template-columns:1fr; } }
    </style>
  </head>
  <body>
    <div class="shell">
      <h1>Build the audience without second-guessing the rules.</h1>
      <p>Pick who should be included, who should stay out, and check the audience size before you save.</p>
      <div class="layout">
        <section class="panel">
          <div class="head"><h2>Audience Rules</h2><p>Add simple include and exclude rules. The same checks run in preview and on save.</p></div>
          <div class="body stack">
            <label for="campaignId">Campaign plan ID</label>
            <input id="campaignId" value="obj_demo_retention_local" />
            <p class="rule-help">Write rules like a sentence: “Include people whose language equals en.”</p>
            <div>
              <h3>Who should be included?</h3>
              <div id="includeList" class="stack"></div>
              <div class="grid">
                <div><label for="includeField">Attribute</label><select id="includeField"></select></div>
                <div><label for="includeOperator">Rule</label><select id="includeOperator"></select></div>
                <div><label for="includeValue">Value</label><input id="includeValue" placeholder='en or 14 or ["en","fr"]' /></div>
                <button id="addInclude" class="secondary" type="button">Add Rule</button>
              </div>
            </div>
            <div>
              <h3>Who should be left out?</h3>
              <div id="excludeList" class="stack"></div>
              <div class="grid">
                <div><label for="excludeField">Attribute</label><select id="excludeField"></select></div>
                <div><label for="excludeOperator">Rule</label><select id="excludeOperator"></select></div>
                <div><label for="excludeValue">Value</label><input id="excludeValue" placeholder='churn-risk or false' /></div>
                <button id="addExclude" class="secondary" type="button">Add Rule</button>
              </div>
            </div>
            <div id="contradictionBox" class="warn"></div>
            <div id="noticeBox" class="notice" role="status" aria-live="polite"></div>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
              <button id="previewButton" class="primary" type="button">Check Audience Size</button>
              <button id="saveButton" class="ghost" type="button">Save Audience</button>
            </div>
          </div>
        </section>
        <aside class="stack">
          <section class="panel"><div class="head"><h3>Audience Check</h3><p>Use this to confirm size and spot contradictions before saving.</p></div><div class="body stack"><div class="summary-grid"><div class="summary-card"><strong>Estimated audience</strong><span id="summaryAudience">Run a check</span></div><div class="summary-card"><strong>Status</strong><span id="summaryStatus">Drafting rules</span></div></div><div class="summary-card"><strong>Notes</strong><span id="summaryNotes">No preview yet.</span></div><details><summary>Show technical details</summary><p class="detail-copy">Worker response for debugging and parity checks.</p><pre id="previewJson"></pre></details></div></section>
          <section class="panel"><div class="head"><h3>Saved Audiences</h3><p>Audience definitions already linked to this campaign plan.</p></div><div id="savedSegments" class="body stack"></div></section>
        </aside>
      </div>
    </div>
    <script>
      const fields = ${JSON.stringify(SEGMENT_FIELDS)};
      const operators = ${JSON.stringify(SEGMENT_OPERATORS)};
      const state = { includeConditions: [], excludeConditions: [] };
      const previewJson = document.getElementById('previewJson');
      const savedSegments = document.getElementById('savedSegments');
      const contradictionBox = document.getElementById('contradictionBox');
      const noticeBox = document.getElementById('noticeBox');
      const summaryAudience = document.getElementById('summaryAudience');
      const summaryStatus = document.getElementById('summaryStatus');
      const summaryNotes = document.getElementById('summaryNotes');
      const fieldLabels = {
        language: 'Language',
        lastSeenDays: 'Last seen days ago',
        bookingCount: 'Booking count',
        routeAffinity: 'Preferred route',
        channelOptIn: 'Channel opt-in',
        appInstalled: 'App installed',
      };
      const operatorLabels = {
        equals: 'equals',
        not_equals: 'does not equal',
        in: 'is one of',
        not_in: 'is not one of',
        gt: 'is greater than',
        gte: 'is at least',
        lt: 'is less than',
        lte: 'is at most',
        contains: 'contains',
      };
      function showNotice(message, tone) {
        noticeBox.textContent = message;
        noticeBox.className = 'notice visible ' + tone;
      }
      function hideNotice() {
        noticeBox.className = 'notice';
        noticeBox.textContent = '';
      }
      function fillSelect(id, values, labelsMap) {
        document.getElementById(id).innerHTML = values.map((value) => '<option value="' + value + '">' + (labelsMap && labelsMap[value] ? labelsMap[value] : value) + '</option>').join('');
      }
      function parseValue(raw) {
        const value = raw.trim();
        if (!value) return '';
        if ((value.startsWith('[') && value.endsWith(']')) || value === 'true' || value === 'false' || /^-?\d+(\.\d+)?$/.test(value)) {
          try { return JSON.parse(value); } catch { return value; }
        }
        return value;
      }
      function describeValue(value) {
        return Array.isArray(value) ? value.join(', ') : String(value);
      }
      function describeCondition(kind, condition) {
        const audience = kind === 'include' ? 'Include people whose ' : 'Leave out people whose ';
        return audience + fieldLabels[condition.field] + ' ' + operatorLabels[condition.operator] + ' ' + describeValue(condition.value) + '.';
      }
      function renderConditions(kind) {
        const key = kind + 'Conditions';
        const root = document.getElementById(kind + 'List');
        root.innerHTML = '';
        state[key].forEach((condition, index) => {
          const row = document.createElement('div');
          row.className = 'condition';
          row.innerHTML = '<span>' + describeCondition(kind, condition) + '</span><button type="button" class="ghost">Remove</button>';
          row.querySelector('button').addEventListener('click', () => {
            state[key].splice(index, 1);
            renderConditions(kind);
          });
          root.appendChild(row);
        });
      }
      function payload() {
        return {
          campaignId: document.getElementById('campaignId').value.trim(),
          includeConditions: state.includeConditions,
          excludeConditions: state.excludeConditions,
        };
      }
      async function loadSaved() {
        const campaignId = document.getElementById('campaignId').value.trim();
        const response = await fetch('/api/segments?campaignId=' + encodeURIComponent(campaignId));
        const body = await response.json();
        savedSegments.innerHTML = '';
        (body.data?.segments || []).forEach((segment) => {
          const card = document.createElement('div');
          card.className = 'condition';
          card.innerHTML = '<span><strong>' + segment.id + '</strong><br/>Saved audience · ' + segment.estimatedAudienceSize + ' people estimated</span>';
          savedSegments.appendChild(card);
        });
        if (!savedSegments.children.length) {
          savedSegments.innerHTML = '<p>No saved audiences yet.</p>';
        }
      }

      function renderSummary(body, responseOk) {
        const data = body && body.data ? body.data : null;
        summaryAudience.textContent = data && typeof data.estimatedAudienceSize === 'number'
          ? data.estimatedAudienceSize.toLocaleString()
          : 'Run a check';
        summaryStatus.textContent = responseOk ? 'Ready to save' : 'Needs attention';
        if (responseOk && data && data.segmentHash) {
          summaryNotes.textContent = 'Hash ' + data.segmentHash.slice(0, 12) + ' is ready for reuse and dedupe.';
        } else if (body && body.data && body.data.contradictions) {
          summaryNotes.textContent = body.data.contradictions.join(' ');
        } else {
          summaryNotes.textContent = 'No preview yet.';
        }
      }

      async function previewSegment() {
        contradictionBox.classList.remove('visible');
        hideNotice();
        const response = await fetch('/api/segments/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
        const body = await response.json();
        previewJson.textContent = JSON.stringify(body, null, 2);
        renderSummary(body, response.ok);
        if (!response.ok && body.data?.contradictions) {
          contradictionBox.textContent = body.data.contradictions.join(' ');
          contradictionBox.classList.add('visible');
          showNotice('These rules conflict with each other. Adjust them and try again.', 'error');
        } else if (response.ok) {
          showNotice('Audience check complete. If the size looks right, you can save it.', 'success');
        }
      }
      async function saveSegment() {
        contradictionBox.classList.remove('visible');
        hideNotice();
        const response = await fetch('/api/segments/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
        const body = await response.json();
        previewJson.textContent = JSON.stringify(body, null, 2);
        renderSummary(body, response.ok);
        if (!response.ok && body.data?.contradictions) {
          contradictionBox.textContent = body.data.contradictions.join(' ');
          contradictionBox.classList.add('visible');
          showNotice('These rules conflict with each other. Adjust them and try again.', 'error');
          return;
        }
        if (response.ok) {
          showNotice(body.data?.deduped ? 'This audience already exists, so the saved version was reused.' : 'Audience saved and ready to reuse.', 'success');
          summaryStatus.textContent = body.data?.deduped ? 'Already saved' : 'Saved';
        }
        await loadSaved();
      }
      function wire(kind) {
        document.getElementById('add' + kind[0].toUpperCase() + kind.slice(1)).addEventListener('click', () => {
          const key = kind + 'Conditions';
          state[key].push({
            field: document.getElementById(kind + 'Field').value,
            operator: document.getElementById(kind + 'Operator').value,
            value: parseValue(document.getElementById(kind + 'Value').value),
          });
          document.getElementById(kind + 'Value').value = '';
          renderConditions(kind);
        });
      }
      fillSelect('includeField', fields, fieldLabels);
      fillSelect('excludeField', fields, fieldLabels);
      fillSelect('includeOperator', operators, operatorLabels);
      fillSelect('excludeOperator', operators, operatorLabels);
      wire('include');
      wire('exclude');
      document.getElementById('previewButton').addEventListener('click', previewSegment);
      document.getElementById('saveButton').addEventListener('click', saveSegment);
      document.getElementById('campaignId').addEventListener('change', loadSaved);
      previewJson.textContent = JSON.stringify(payload(), null, 2);
      loadSaved();
    </script>
  </body>
</html>`;
}

export async function handleSegmentSelectionScreen(_request: Request, _env: Env): Promise<Response> {
  return new Response(screenHtml(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
