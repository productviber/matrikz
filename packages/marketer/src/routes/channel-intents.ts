import type { Env } from '../types';
import { created, ok, serverError, badRequest } from '../lib/response';
import { execute, now, query, queryOne } from '../lib/db';
import {
  CHANNEL_LABELS,
  CHANNEL_OPTIONS,
  getChannelCompatibilityWarnings,
  normalizeChannelIntentProfile,
  resolveChannelIntent,
  type ChannelAvailability,
} from '../lib/campaign-planning/shared';

interface ChannelIntentRow {
  scope_type: 'campaign' | 'segment';
  scope_id: string;
  campaign_id: string;
  segment_id: string | null;
  hard_block_json: string;
  preferred_json: string;
  fallback_json: string;
  created_at: number;
  updated_at: number;
}

function toIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function mapRow(row: ChannelIntentRow) {
  const profile = {
    hardBlockChannels: JSON.parse(row.hard_block_json),
    preferredChannels: JSON.parse(row.preferred_json),
    fallbackChannels: JSON.parse(row.fallback_json),
  };
  return {
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    campaignId: row.campaign_id,
    segmentId: row.segment_id,
    profile,
    warnings: getChannelCompatibilityWarnings(profile),
    updatedAt: toIso(row.updated_at),
  };
}

async function readCampaignIntent(env: Env, campaignId: string) {
  return queryOne<ChannelIntentRow>(
    env.DB,
    `SELECT * FROM channel_intents WHERE scope_type = 'campaign' AND scope_id = ?`,
    [campaignId],
  );
}

export async function handlePutChannelIntent(request: Request, env: Env, campaignId: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Invalid JSON body');
  }

  const record = isRecord(body) ? body : {};
  const profile = normalizeChannelIntentProfile(record);
  if (profile.preferredChannels.length === 0) {
    return badRequest('preferredChannels must include at least one channel');
  }

  const segmentId = typeof record.segmentId === 'string' && record.segmentId.trim() ? record.segmentId.trim() : null;
  const scopeType = segmentId ? 'segment' : 'campaign';
  const scopeId = segmentId ?? campaignId;
  const epoch = now();

  try {
    await execute(
      env.DB,
      `INSERT INTO channel_intents (
        scope_type,
        scope_id,
        campaign_id,
        segment_id,
        hard_block_json,
        preferred_json,
        fallback_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_type, scope_id) DO UPDATE SET
        campaign_id = excluded.campaign_id,
        segment_id = excluded.segment_id,
        hard_block_json = excluded.hard_block_json,
        preferred_json = excluded.preferred_json,
        fallback_json = excluded.fallback_json,
        updated_at = excluded.updated_at`,
      [
        scopeType,
        scopeId,
        campaignId,
        segmentId,
        JSON.stringify(profile.hardBlockChannels),
        JSON.stringify(profile.preferredChannels),
        JSON.stringify(profile.fallbackChannels),
        epoch,
        epoch,
      ],
    );

    const persisted = await queryOne<ChannelIntentRow>(
      env.DB,
      `SELECT * FROM channel_intents WHERE scope_type = ? AND scope_id = ?`,
      [scopeType, scopeId],
    );
    if (!persisted) {
      return serverError('Failed to persist channel intent');
    }

    const availability = isRecord(record.sampleAvailability) ? (record.sampleAvailability as ChannelAvailability) : {};
    return created({
      intent: mapRow(persisted),
      resolverPreview: resolveChannelIntent(profile, availability),
      labels: CHANNEL_LABELS,
    });
  } catch (error) {
    console.error('[ChannelIntent:Put] Error:', error);
    return serverError('Failed to persist channel intent');
  }
}

export async function handleGetChannelIntent(request: Request, env: Env, campaignId: string): Promise<Response> {
  try {
    const row = await readCampaignIntent(env, campaignId);
    const overrides = await query<ChannelIntentRow>(
      env.DB,
      `SELECT * FROM channel_intents WHERE scope_type = 'segment' AND campaign_id = ? ORDER BY updated_at DESC`,
      [campaignId],
    );
    const availabilityParam = new URL(request.url).searchParams.get('availability');
    const availability = availabilityParam ? (JSON.parse(availabilityParam) as ChannelAvailability) : {};
    const profile = row
      ? {
          hardBlockChannels: JSON.parse(row.hard_block_json),
          preferredChannels: JSON.parse(row.preferred_json),
          fallbackChannels: JSON.parse(row.fallback_json),
        }
      : { hardBlockChannels: [], preferredChannels: [], fallbackChannels: [] };

    return ok({
      intent: row ? mapRow(row) : null,
      segmentOverrides: overrides.map(mapRow),
      resolverPreview: resolveChannelIntent(profile, availability),
      labels: CHANNEL_LABELS,
    });
  } catch (error) {
    console.error('[ChannelIntent:Get] Error:', error);
    return serverError('Failed to load channel intent');
  }
}

function screenHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Channel Intent | Visibility Marketing</title>
    <style>
      :root { --bg:#f6f1e8; --panel:#fffdf8; --line:#dad1c4; --ink:#162027; --muted:#5e6670; --accent:#0f766e; --warn:#b54708; }
      * { box-sizing:border-box; }
      body { margin:0; font-family:Georgia,serif; background:linear-gradient(180deg,#fbf7f0,var(--bg)); color:var(--ink); }
      .shell { max-width:1080px; margin:0 auto; padding:30px 18px 42px; }
      h1 { margin:0 0 10px; font-size:clamp(32px,6vw,52px); line-height:.95; }
      .layout { display:grid; grid-template-columns:1.1fr .9fr; gap:22px; }
      .panel { background:var(--panel); border:1px solid var(--line); border-radius:22px; overflow:hidden; box-shadow:0 10px 28px rgba(22,32,39,.08); }
      .head { padding:18px 20px 12px; border-bottom:1px solid var(--line); }
      .body { padding:18px 20px 22px; display:grid; gap:16px; }
      label { display:block; font:12px Arial,sans-serif; text-transform:uppercase; letter-spacing:.08em; margin-bottom:6px; }
      input { width:100%; padding:11px 12px; border:1px solid var(--line); border-radius:14px; }
      ul { list-style:none; margin:0; padding:0; display:grid; gap:10px; }
      li { border:1px solid var(--line); border-radius:16px; background:white; padding:12px 14px; display:flex; justify-content:space-between; gap:10px; align-items:center; font-family:Arial,sans-serif; }
      li.dragging { opacity:.5; }
      .chip { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
      .warn { background:rgba(181,71,8,.09); color:var(--warn); padding:12px 14px; border-radius:16px; display:none; font-family:Arial,sans-serif; }
      .warn.visible { display:block; }
      .summary-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
      .summary-card { border:1px solid var(--line); border-radius:16px; padding:14px; background:white; font-family:Arial,sans-serif; }
      .summary-card strong { display:block; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.05em; margin-bottom:6px; }
      details { border:1px solid var(--line); border-radius:16px; background:#f4eee5; padding:14px; }
      summary { cursor:pointer; font:700 14px Arial,sans-serif; }
      .detail-copy { margin:8px 0 0; color:var(--muted); font:13px Arial,sans-serif; }
      button { border:none; border-radius:999px; padding:10px 14px; cursor:pointer; font-weight:700; }
      .mini { padding:6px 10px; font-size:12px; }
      .primary { background:var(--accent); color:white; }
      .ghost { background:transparent; border:1px solid var(--line); }
      pre { margin:0; background:#121c22; color:#deeaee; border-radius:16px; padding:16px; overflow:auto; font-size:13px; }
      .toggle-grid { display:grid; grid-template-columns:repeat(5, minmax(0,1fr)); gap:10px; }
      .toggle-grid label { text-transform:none; letter-spacing:0; font:14px Arial,sans-serif; display:flex; gap:8px; align-items:center; border:1px solid var(--line); padding:10px 12px; border-radius:14px; background:white; }
      @media (max-width: 900px) { .layout { grid-template-columns:1fr; } .toggle-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    </style>
  </head>
  <body>
    <div class="shell">
      <h1>Choose the safest path for each message.</h1>
      <p>Set a preferred order, block channels you do not want used, and check how delivery will behave before saving.</p>
      <div class="layout">
        <section class="panel"><div class="head"><h2>Delivery Preferences</h2><p>Choose the order you prefer. You can drag rows or use the move buttons for smaller adjustments.</p></div><div class="body">
          <div><label for="campaignId">Campaign plan ID</label><input id="campaignId" value="obj_demo_retention_local" /></div>
          <div><label>Preferred channel order</label><ul id="preferredList"></ul></div>
          <div><label>Never use these channels</label><div id="hardBlocks" class="toggle-grid"></div></div>
          <div><label>Fallback options</label><div id="fallbacks" class="toggle-grid"></div></div>
          <div id="warningBox" class="warn"></div>
          <div style="display:flex; gap:10px; flex-wrap:wrap;">
            <button id="saveButton" class="primary" type="button">Save Preferences</button>
            <button id="loadButton" class="ghost" type="button">Reload</button>
          </div>
        </div></section>
        <aside class="panel"><div class="head"><h3>Delivery Check</h3><p>See which channel would be chosen from these preferences.</p></div><div class="body">
          <div><label>Available for this example contact</label><div id="availability" class="toggle-grid"></div></div>
          <div class="summary-grid"><div class="summary-card"><strong>Chosen channel</strong><span id="summarySelected">No channel selected yet</span></div><div class="summary-card"><strong>Fallback path</strong><span id="summaryCandidates">Set preferences to preview</span></div></div>
          <details><summary>Show technical details</summary><p class="detail-copy">Resolver payload and ordering for debugging.</p><pre id="previewJson"></pre></details>
        </div></aside>
      </div>
    </div>
    <script>
      const labels = ${JSON.stringify(CHANNEL_LABELS)};
      const channels = ${JSON.stringify(CHANNEL_OPTIONS)};
      const state = { preferredChannels: [...channels], hardBlockChannels: [], fallbackChannels: ['push'], availability: {} };
      const preferredList = document.getElementById('preferredList');
      const previewJson = document.getElementById('previewJson');
      const warningBox = document.getElementById('warningBox');
      const summarySelected = document.getElementById('summarySelected');
      const summaryCandidates = document.getElementById('summaryCandidates');
      function renderPreferred() {
        preferredList.innerHTML = '';
        state.preferredChannels.forEach((channel) => {
          const li = document.createElement('li');
          li.draggable = true;
          li.dataset.channel = channel;
          li.innerHTML = '<span><strong>' + labels[channel].defaultLabel + '</strong></span><span style="display:flex; gap:8px;"><button type="button" class="ghost mini" data-move="up">Up</button><button type="button" class="ghost mini" data-move="down">Down</button></span>';
          li.querySelector('[data-move="up"]').addEventListener('click', () => {
            const from = state.preferredChannels.indexOf(channel);
            if (from <= 0) return;
            const moved = state.preferredChannels.splice(from, 1)[0];
            state.preferredChannels.splice(from - 1, 0, moved);
            renderPreferred();
            renderPreview();
          });
          li.querySelector('[data-move="down"]').addEventListener('click', () => {
            const from = state.preferredChannels.indexOf(channel);
            if (from === -1 || from >= state.preferredChannels.length - 1) return;
            const moved = state.preferredChannels.splice(from, 1)[0];
            state.preferredChannels.splice(from + 1, 0, moved);
            renderPreferred();
            renderPreview();
          });
          li.addEventListener('dragstart', () => li.classList.add('dragging'));
          li.addEventListener('dragend', () => li.classList.remove('dragging'));
          li.addEventListener('dragover', (event) => event.preventDefault());
          li.addEventListener('drop', (event) => {
            event.preventDefault();
            const dragging = preferredList.querySelector('.dragging');
            if (!dragging || dragging === li) return;
            const from = state.preferredChannels.indexOf(dragging.dataset.channel);
            const to = state.preferredChannels.indexOf(channel);
            const moved = state.preferredChannels.splice(from, 1)[0];
            state.preferredChannels.splice(to, 0, moved);
            renderPreferred();
            renderPreview();
          });
          preferredList.appendChild(li);
        });
      }
      function renderChecks(rootId, key) {
        const root = document.getElementById(rootId);
        root.innerHTML = '';
        channels.forEach((channel) => {
          const label = document.createElement('label');
          const isArrayState = Array.isArray(state[key]);
          const checked = isArrayState ? state[key].includes(channel) : Boolean(state[key][channel]);
          label.innerHTML = '<input type="checkbox" ' + (checked ? 'checked' : '') + ' />' + labels[channel].defaultLabel;
          label.querySelector('input').addEventListener('change', (event) => {
            if (isArrayState) {
              const next = event.target.checked
                ? [...state[key], channel].filter((value, index, array) => array.indexOf(value) === index)
                : state[key].filter((value) => value !== channel);
              state[key] = next;
            } else {
              state[key][channel] = event.target.checked;
            }
            renderPreview();
          });
          root.appendChild(label);
        });
      }
      function payload() {
        return {
          hardBlockChannels: state.hardBlockChannels,
          preferredChannels: state.preferredChannels,
          fallbackChannels: state.fallbackChannels,
          sampleAvailability: state.availability,
        };
      }
      async function loadIntent() {
        const campaignId = document.getElementById('campaignId').value.trim();
        const response = await fetch('/api/campaigns/' + encodeURIComponent(campaignId) + '/channel-intent');
        const body = await response.json();
        if (body.data?.intent) {
          state.hardBlockChannels = body.data.intent.profile.hardBlockChannels;
          state.preferredChannels = body.data.intent.profile.preferredChannels;
          state.fallbackChannels = body.data.intent.profile.fallbackChannels;
        }
        renderPreferred();
        renderChecks('hardBlocks', 'hardBlockChannels');
        renderChecks('fallbacks', 'fallbackChannels');
        renderChecks('availability', 'availability');
        renderPreview();
      }
      function renderPreview() {
        const warning = state.preferredChannels.length === 1 && state.preferredChannels[0] === 'email' && state.fallbackChannels.length === 0
          ? 'Email-only intent is saved, but Skrip strategic dispatch currently sends directly through push, WhatsApp, Telegram, and SMS.'
          : '';
        warningBox.textContent = warning;
        warningBox.classList.toggle('visible', Boolean(warning));
        const orderedCandidates = state.preferredChannels
          .concat(state.fallbackChannels.filter((channel) => !state.preferredChannels.includes(channel)))
          .filter((channel) => !state.hardBlockChannels.includes(channel));
        const selectedChannel = orderedCandidates.find((channel) => state.availability[channel]) || null;
        summarySelected.textContent = selectedChannel ? labels[selectedChannel].defaultLabel : 'No available channel matched';
        summaryCandidates.textContent = orderedCandidates.length ? orderedCandidates.map((channel) => labels[channel].defaultLabel).join(' → ') : 'Set preferences to preview';
        previewJson.textContent = JSON.stringify({ payload: payload(), resolverPreview: { selectedChannel, orderedCandidates, blockedChannels: state.hardBlockChannels } }, null, 2);
      }
      renderPreferred();
      renderChecks('hardBlocks', 'hardBlockChannels');
      renderChecks('fallbacks', 'fallbackChannels');
      renderChecks('availability', 'availability');
      renderPreview();
      document.getElementById('saveButton').addEventListener('click', async () => {
        const campaignId = document.getElementById('campaignId').value.trim();
        const response = await fetch('/api/campaigns/' + encodeURIComponent(campaignId) + '/channel-intent', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
        const body = await response.json();
        previewJson.textContent = JSON.stringify(body, null, 2);
      });
      document.getElementById('loadButton').addEventListener('click', loadIntent);
    </script>
  </body>
</html>`;
}

export async function handleChannelIntentScreen(_request: Request, _env: Env): Promise<Response> {
  return new Response(screenHtml(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
