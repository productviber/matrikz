import type { Env, GrowthSkripStrategicRequest } from '../types';
import { ok, serverError, badRequest } from '../lib/response';
import { now, queryOne, execute } from '../lib/db';
import {
  CHANNEL_LABELS,
  CHANNEL_OPTIONS,
  DIRECT_STRATEGIC_CHANNELS,
  getChannelCompatibilityWarnings,
  MAX_STRATEGIC_LIST_ITEMS,
  normalizeChannelIntentProfile,
  type ChannelIntentProfile,
} from '../lib/campaign-planning/shared';
import {
  ensureStrategyNonceUnused,
  sendStrategicRequestToSkrip,
  validateAllowedHours,
} from '../lib/campaign-planning/strategy';
import { getCorrelationId } from '../lib/correlation';

interface CampaignObjectiveLookup {
  id: string;
  objective_type: string;
  campaign_name: string;
  business_goal_statement: string;
  urgency: string;
  dry_run: number;
}

interface StrategicBriefPayload {
  campaignId: string;
  headline: string;
  bodyIntent: string;
  cta: string;
  tone: string;
  forbiddenClaims: string[];
  complianceTags: string[];
  locale: string;
  allowedHours: {
    startHour: number;
    endHour: number;
    timezone: string;
  };
  fallbackTemplateKey: string | null;
  personalizationHints: string[];
  channelPriority: string[];
  strategyNonce: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)));
}

function normalizeStrategicBriefPayload(payload: unknown): { value: StrategicBriefPayload | null; fieldErrors: Record<string, string> } {
  if (!isRecord(payload)) return { value: null, fieldErrors: { form: 'Strategic brief payload is invalid.' } };
  const fieldErrors: Record<string, string> = {};
  const campaignId = typeof payload.campaignId === 'string' ? payload.campaignId.trim() : '';
  const headline = typeof payload.headline === 'string' ? payload.headline.trim() : '';
  const bodyIntent = typeof payload.bodyIntent === 'string' ? payload.bodyIntent.trim() : '';
  const cta = typeof payload.cta === 'string' ? payload.cta.trim() : '';
  const tone = typeof payload.tone === 'string' ? payload.tone.trim() : '';
  const locale = typeof payload.locale === 'string' ? payload.locale.trim() : '';
  const fallbackTemplateKey = typeof payload.fallbackTemplateKey === 'string' && payload.fallbackTemplateKey.trim()
    ? payload.fallbackTemplateKey.trim()
    : null;
  const strategyNonce = typeof payload.strategyNonce === 'string' ? payload.strategyNonce.trim() : '';
  const forbiddenClaims = normalizeStringList(payload.forbiddenClaims);
  const complianceTags = normalizeStringList(payload.complianceTags);
  const personalizationHints = normalizeStringList(payload.personalizationHints);
  const channelPriority = normalizeStringList(payload.channelPriority).filter((entry) => CHANNEL_OPTIONS.includes(entry as any));
  const allowedHours = validateAllowedHours(payload.allowedHours);

  if (!campaignId) fieldErrors.campaignId = 'campaignId is required.';
  if (!headline) fieldErrors.headline = 'headline is required.';
  if (!bodyIntent) fieldErrors.bodyIntent = 'bodyIntent is required.';
  if (!cta) fieldErrors.cta = 'cta is required.';
  if (!tone) fieldErrors.tone = 'tone is required.';
  if (!locale) fieldErrors.locale = 'locale is required.';
  if (!strategyNonce) fieldErrors.strategyNonce = 'strategyNonce is required.';
  if (channelPriority.length === 0) fieldErrors.channelPriority = 'Select at least one channel.';
  Object.assign(fieldErrors, allowedHours.errors);

  if (Object.keys(fieldErrors).length > 0 || !allowedHours.value) {
    return { value: null, fieldErrors };
  }

  return {
    value: {
      campaignId,
      headline,
      bodyIntent,
      cta,
      tone,
      forbiddenClaims,
      complianceTags,
      locale,
      allowedHours: allowedHours.value,
      fallbackTemplateKey,
      personalizationHints,
      channelPriority,
      strategyNonce,
    },
    fieldErrors: {},
  };
}

async function loadObjective(env: Env, campaignId: string): Promise<CampaignObjectiveLookup | null> {
  return queryOne<CampaignObjectiveLookup>(
    env.DB,
    `SELECT id, objective_type, campaign_name, business_goal_statement, urgency, dry_run FROM campaign_objectives WHERE id = ?`,
    [campaignId],
  );
}

async function loadChannelIntentProfile(env: Env, campaignId: string): Promise<ChannelIntentProfile> {
  const row = await queryOne<{
    hard_block_json: string;
    preferred_json: string;
    fallback_json: string;
  }>(env.DB, `SELECT hard_block_json, preferred_json, fallback_json FROM channel_intents WHERE scope_type = 'campaign' AND scope_id = ?`, [campaignId]);

  if (!row) {
    return { hardBlockChannels: [], preferredChannels: [], fallbackChannels: [] };
  }

  return normalizeChannelIntentProfile({
    hardBlockChannels: JSON.parse(row.hard_block_json),
    preferredChannels: JSON.parse(row.preferred_json),
    fallbackChannels: JSON.parse(row.fallback_json),
  });
}

async function buildStrategicRequest(env: Env, payload: StrategicBriefPayload): Promise<GrowthSkripStrategicRequest> {
  const objective = await loadObjective(env, payload.campaignId);
  if (!objective) {
    throw new Error('Campaign objective not found.');
  }

  const channelIntent = await loadChannelIntentProfile(env, payload.campaignId);
  const preferredChannels = payload.channelPriority.filter((channel) => DIRECT_STRATEGIC_CHANNELS.includes(channel as any));
  const fallbackChannels = channelIntent.fallbackChannels.filter((channel) => DIRECT_STRATEGIC_CHANNELS.includes(channel as any));
  const channelPreferences = Array.from(new Set([...preferredChannels, ...fallbackChannels]));

  return {
    tenantId: 'default',
    subjectId: payload.campaignId,
    contactIdentityId: payload.campaignId,
    objective: `${objective.objective_type}:${objective.campaign_name}`,
    urgency: objective.urgency,
    reason: objective.business_goal_statement,
    channelPreferences: channelPreferences.length > 0 ? channelPreferences : ['push'],
    constraints: {
      brandVoice: payload.tone,
      locale: payload.locale,
      forbiddenClaims: payload.forbiddenClaims,
      complianceTags: payload.complianceTags,
      allowedHours: payload.allowedHours,
    },
    brief: {
      objective: objective.business_goal_statement,
      channel: payload.channelPriority[0] ?? 'push',
      locale: payload.locale,
      headline: payload.headline,
      bodyIntent: payload.bodyIntent,
      cta: payload.cta,
      tone: payload.tone,
      personalizationHints: payload.personalizationHints,
      offerContext: { campaignId: payload.campaignId, campaignName: objective.campaign_name },
      fallbackTemplateKey: payload.fallbackTemplateKey,
    },
    lineage: {
      correlationId: getCorrelationId(),
      requestId: payload.strategyNonce,
      agentActionId: null,
      growthCapability: 'visibility-marketing-strategic-briefing',
      promptVersion: 'campaign-briefing.v1',
      responseSchemaVersion: 'skrip-strategic-response.v1',
      strategyVersion: 'visibility-marketing-strategic-briefing.v1',
    },
    execution: {
      dryRun: objective.dry_run === 1,
      idempotencyKey: `${payload.campaignId}:${payload.strategyNonce}`,
      priority: objective.urgency === 'high' ? 'high' : 'normal',
    },
  };
}

export async function handleSendStrategicBrief(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Invalid JSON body');
  }

  const normalized = normalizeStrategicBriefPayload(body);
  if (!normalized.value) {
    return jsonValidation(normalized.fieldErrors);
  }

  const nonceUnused = await ensureStrategyNonceUnused(env, normalized.value.strategyNonce);
  if (!nonceUnused) {
    return badRequest('strategyNonce has already been used.');
  }

  try {
    const requestBody = await buildStrategicRequest(env, normalized.value);
    const { response, signature } = await sendStrategicRequestToSkrip<any>(env, {
      tenantId: requestBody.tenantId,
      requestBody,
      nonce: normalized.value.strategyNonce,
    });

    await execute(
      env.DB,
      `INSERT INTO strategic_brief_logs (
        id,
        campaign_id,
        payload_json,
        request_json,
        response_json,
        strategy_signature,
        strategy_timestamp,
        strategy_nonce,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `brief_${crypto.randomUUID().replace(/-/g, '')}`,
        normalized.value.campaignId,
        JSON.stringify(normalized.value),
        JSON.stringify(requestBody),
        JSON.stringify(response),
        signature.signature,
        signature.timestamp,
        signature.nonce,
        now(),
      ],
    );

    return ok({
      requestBody,
      signing: signature,
      warnings: getChannelCompatibilityWarnings({
        hardBlockChannels: [],
        preferredChannels: normalized.value.channelPriority as any,
        fallbackChannels: [],
      }),
      responseEnvelope: {
        deliveryMode: response.deliveryMode ?? null,
        channelSelected: response.channelSelected ?? null,
        policyAdjustments: response.policyAdjustments ?? [],
        usedFallbackTemplate: response.usedFallbackTemplate ?? false,
        requestId: response.requestId ?? signature.nonce,
      },
    });
  } catch (error) {
    console.error('[StrategicBrief:Send] Error:', error);
    return serverError(error instanceof Error ? error.message : 'Failed to send strategic brief');
  }
}

function jsonValidation(fieldErrors: Record<string, string>): Response {
  return new Response(JSON.stringify({ ok: false, error: 'Strategic brief payload is invalid.', code: 'bad_request', data: { fieldErrors } }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

function screenHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Strategic Briefing | Visibility Marketing</title>
    <style>
      :root { --bg:#f5efe6; --panel:#fffdf8; --line:#d8cfc1; --ink:#182127; --muted:#5b6670; --accent:#0f766e; }
      * { box-sizing:border-box; } body { margin:0; font-family:Georgia,serif; color:var(--ink); background:linear-gradient(180deg,#fbf8f2,var(--bg)); }
      .shell { max-width:1180px; margin:0 auto; padding:28px 18px 40px; } h1 { margin:0 0 10px; font-size:clamp(32px,6vw,54px); line-height:.95; }
      .layout { display:grid; grid-template-columns:1.1fr .9fr; gap:22px; } .panel { background:var(--panel); border:1px solid var(--line); border-radius:22px; overflow:hidden; box-shadow:0 10px 28px rgba(24,33,39,.08); }
      .head { padding:18px 20px 12px; border-bottom:1px solid var(--line); } .body { padding:18px 20px 22px; display:grid; gap:14px; }
      .grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; } .full { grid-column:1 / -1; } label { display:block; font:12px Arial,sans-serif; text-transform:uppercase; letter-spacing:.08em; margin-bottom:6px; }
      input, textarea, select { width:100%; padding:11px 12px; border:1px solid var(--line); border-radius:14px; background:white; } textarea { min-height:110px; }
      .tag-editor { display:grid; gap:8px; border:1px solid var(--line); border-radius:14px; padding:10px; background:white; }
      .tag-editor input { border:none; padding:0; border-radius:0; }
      .tag-editor input:focus { outline:none; }
      .tag-list { display:flex; gap:8px; flex-wrap:wrap; min-height:20px; }
      .tag { display:inline-flex; align-items:center; gap:8px; border-radius:999px; padding:8px 12px; background:#ebe5dc; font:13px Arial,sans-serif; }
      .tag-remove { cursor:pointer; color:var(--muted); font-weight:700; }
      .check-grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:10px; } .check-grid label { text-transform:none; letter-spacing:0; font:14px Arial,sans-serif; display:flex; gap:8px; align-items:center; border:1px solid var(--line); padding:10px 12px; border-radius:14px; background:white; }
      .summary-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
      .summary-card { border:1px solid var(--line); border-radius:16px; padding:14px; background:white; font-family:Arial,sans-serif; }
      .summary-card strong { display:block; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.05em; margin-bottom:6px; }
      details { border:1px solid var(--line); border-radius:16px; background:#f4eee5; padding:14px; }
      summary { cursor:pointer; font:700 14px Arial,sans-serif; }
      .detail-copy { margin:8px 0 0; color:var(--muted); font:13px Arial,sans-serif; }
      .notice { display:none; border-radius:16px; padding:12px 14px; font:14px Arial,sans-serif; }
      .notice.visible { display:block; }
      .notice.success { background:rgba(15,118,110,.12); color:#0d625c; }
      .notice.error { background:rgba(181,71,8,.12); color:#8a3d06; }
      button { border:none; border-radius:999px; padding:11px 15px; cursor:pointer; font-weight:700; } .primary { background:var(--accent); color:white; } .ghost { background:transparent; border:1px solid var(--line); }
      pre { margin:0; background:#111a20; color:#dce8ed; border-radius:16px; padding:16px; overflow:auto; font-size:13px; }
      .hint { color:var(--muted); font-family:Arial,sans-serif; font-size:13px; }
      @media (max-width: 920px) { .layout { grid-template-columns:1fr; } .check-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    </style>
  </head>
  <body>
    <div class="shell">
      <h1>Shape the message before you send it.</h1>
      <p>Set the message direction, choose where it should go first, and review a simple send summary before dispatch.</p>
      <div class="layout">
        <section class="panel"><div class="head"><h2>Message Brief</h2><p>Capture the message intent in plain language. Delivery rules are handled behind the scenes.</p></div><div class="body">
          <div class="grid">
            <div><label for="campaignId">Campaign plan ID</label><input id="campaignId" value="obj_demo_retention_local" /></div>
            <div><label for="locale">Locale</label><input id="locale" value="en" /></div>
            <div class="full"><label for="headline">Headline</label><input id="headline" value="Re-engage users before intent cools" /></div>
            <div class="full"><label for="bodyIntent">Message direction</label><textarea id="bodyIntent">Send a concise, high-trust follow-up to users who showed activation intent but stopped short.</textarea></div>
            <div><label for="cta">Next step</label><input id="cta" value="Finish activation" /></div>
            <div><label for="tone">Tone</label><input id="tone" value="calm, direct, useful" /></div>
            <div><label for="forbiddenClaimsInput">Avoid saying</label><div class="tag-editor"><div id="forbiddenClaimsTags" class="tag-list"></div><input id="forbiddenClaimsInput" placeholder="Type a phrase and press Enter" /></div></div>
            <div><label for="complianceTagsInput">Policy tags</label><div class="tag-editor"><div id="complianceTagsTags" class="tag-list"></div><input id="complianceTagsInput" placeholder="Add a tag and press Enter" /></div></div>
            <div><label for="startHour">Earliest send hour</label><input id="startHour" value="9" type="number" min="0" max="23" /></div>
            <div><label for="endHour">Latest send hour</label><input id="endHour" value="18" type="number" min="0" max="23" /></div>
            <div><label for="timezone">Timezone</label><input id="timezone" value="UTC" /></div>
            <div><label for="fallbackTemplateKey">Fallback template</label><input id="fallbackTemplateKey" value="agentic-skrip-followup" /></div>
            <div class="full"><label for="personalizationHintsInput">Personalization hints</label><div class="tag-editor"><div id="personalizationHintsTags" class="tag-list"></div><input id="personalizationHintsInput" placeholder="Add a hint and press Enter" /></div></div>
          </div>
          <div><label>Where should we try first?</label><div id="channelPriority" class="check-grid"></div></div>
          <div class="hint">Each send gets a fresh request token automatically so accidental duplicates are blocked.</div>
          <div id="sendNotice" class="notice" role="status" aria-live="polite"></div>
          <div style="display:flex; gap:10px; flex-wrap:wrap;"><button id="sendButton" class="primary" type="button">Send Brief</button><button id="refreshPreview" class="ghost" type="button">Refresh Summary</button></div>
        </div></section>
        <aside class="panel"><div class="head"><h3>Ready to Send?</h3><p>Review the essentials first. Technical request details are available if you need them.</p></div><div class="body"><div class="summary-grid"><div class="summary-card"><strong>First-choice channels</strong><span id="summaryChannels">Choose one or more channels</span></div><div class="summary-card"><strong>Send window</strong><span id="summaryWindow">Set a time window</span></div><div class="summary-card"><strong>Fallback</strong><span id="summaryFallback">No fallback template set</span></div><div class="summary-card"><strong>Last result</strong><span id="summaryResult">Nothing sent yet</span></div></div><details><summary>Show technical request</summary><p class="detail-copy">Signed worker payload sent to Skrip.</p><pre id="previewJson"></pre></details><details><summary>Show latest response</summary><p class="detail-copy">Worker response after sending the brief.</p><pre id="responseJson"></pre></details></div></aside>
      </div>
    </div>
    <script>
      const channels = ${JSON.stringify(CHANNEL_OPTIONS)};
      const labels = ${JSON.stringify(CHANNEL_LABELS)};
      const maxListItems = ${MAX_STRATEGIC_LIST_ITEMS};
      const usedNonces = new Set();
      const listState = {
        forbiddenClaims: ['guaranteed results'],
        complianceTags: ['marketing', 'consent_required'],
        personalizationHints: ['plan', 'last_seen'],
      };
      const priorityRoot = document.getElementById('channelPriority');
      const previewJson = document.getElementById('previewJson');
      const responseJson = document.getElementById('responseJson');
      const summaryChannels = document.getElementById('summaryChannels');
      const summaryWindow = document.getElementById('summaryWindow');
      const summaryFallback = document.getElementById('summaryFallback');
      const summaryResult = document.getElementById('summaryResult');
      const sendNotice = document.getElementById('sendNotice');
      function renderChannels() {
        priorityRoot.innerHTML = '';
        channels.forEach((channel, index) => {
          const label = document.createElement('label');
          label.innerHTML = '<input type="checkbox" ' + (index < 3 ? 'checked' : '') + ' value="' + channel + '" />' + labels[channel].defaultLabel;
          priorityRoot.appendChild(label);
        });
      }
      function showNotice(message, tone) {
        sendNotice.textContent = message;
        sendNotice.className = 'notice visible ' + tone;
      }
      function hideNotice() {
        sendNotice.className = 'notice';
        sendNotice.textContent = '';
      }
      function renderTagField(key, rootId) {
        const root = document.getElementById(rootId);
        root.innerHTML = '';
        listState[key].forEach((value, index) => {
          const item = document.createElement('span');
          item.className = 'tag';
          item.innerHTML = '<span>' + value + '</span><span class="tag-remove" role="button" tabindex="0" aria-label="Remove ' + value + '">×</span>';
          const remove = () => {
            listState[key].splice(index, 1);
            renderTagField(key, rootId);
            refreshPreview();
          };
          item.querySelector('.tag-remove').addEventListener('click', remove);
          item.querySelector('.tag-remove').addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              remove();
            }
          });
          root.appendChild(item);
        });
      }
      function addTag(key, rawValue, rootId, inputId) {
        const value = rawValue.trim();
        if (!value) return;
        if (listState[key].includes(value)) {
          document.getElementById(inputId).value = '';
          return;
        }
        if (listState[key].length >= maxListItems) {
          showNotice('Keep each list to ' + maxListItems + ' items or fewer.', 'error');
          return;
        }
        listState[key].push(value);
        document.getElementById(inputId).value = '';
        renderTagField(key, rootId);
        refreshPreview();
      }
      function attachTagInput(key, inputId, rootId) {
        const input = document.getElementById(inputId);
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            addTag(key, input.value, rootId, inputId);
          }
        });
        input.addEventListener('blur', () => addTag(key, input.value, rootId, inputId));
      }
      function payload() {
        return {
          campaignId: document.getElementById('campaignId').value.trim(),
          headline: document.getElementById('headline').value.trim(),
          bodyIntent: document.getElementById('bodyIntent').value.trim(),
          cta: document.getElementById('cta').value.trim(),
          tone: document.getElementById('tone').value.trim(),
          forbiddenClaims: [...listState.forbiddenClaims],
          complianceTags: [...listState.complianceTags],
          locale: document.getElementById('locale').value.trim(),
          allowedHours: {
            startHour: Number(document.getElementById('startHour').value),
            endHour: Number(document.getElementById('endHour').value),
            timezone: document.getElementById('timezone').value.trim(),
          },
          fallbackTemplateKey: document.getElementById('fallbackTemplateKey').value.trim(),
          personalizationHints: [...listState.personalizationHints],
          channelPriority: Array.from(priorityRoot.querySelectorAll('input:checked')).map((input) => input.value),
          strategyNonce: crypto.randomUUID(),
        };
      }
      async function refreshPreview() {
        const next = payload();
        previewJson.textContent = JSON.stringify(next, null, 2);
        summaryChannels.textContent = next.channelPriority.length ? next.channelPriority.map((channel) => labels[channel].defaultLabel).join(', ') : 'Choose one or more channels';
        summaryWindow.textContent = next.allowedHours.timezone + ' · ' + next.allowedHours.startHour + ':00 to ' + next.allowedHours.endHour + ':00';
        summaryFallback.textContent = next.fallbackTemplateKey || 'No fallback template set';
      }
      renderChannels();
      renderTagField('forbiddenClaims', 'forbiddenClaimsTags');
      renderTagField('complianceTags', 'complianceTagsTags');
      renderTagField('personalizationHints', 'personalizationHintsTags');
      attachTagInput('forbiddenClaims', 'forbiddenClaimsInput', 'forbiddenClaimsTags');
      attachTagInput('complianceTags', 'complianceTagsInput', 'complianceTagsTags');
      attachTagInput('personalizationHints', 'personalizationHintsInput', 'personalizationHintsTags');
      refreshPreview();
      priorityRoot.addEventListener('change', refreshPreview);
      document.querySelectorAll('#campaignId, #locale, #headline, #bodyIntent, #cta, #tone, #startHour, #endHour, #timezone, #fallbackTemplateKey').forEach((node) => {
        node.addEventListener('input', refreshPreview);
      });
      document.getElementById('refreshPreview').addEventListener('click', refreshPreview);
      document.getElementById('sendButton').addEventListener('click', async () => {
        hideNotice();
        const requestPayload = payload();
        if (usedNonces.has(requestPayload.strategyNonce)) {
          responseJson.textContent = JSON.stringify({ ok: false, error: 'Duplicate client nonce blocked.' }, null, 2);
          summaryResult.textContent = 'Blocked duplicate send';
          showNotice('This request token was already used. Refresh the summary and try again.', 'error');
          return;
        }
        usedNonces.add(requestPayload.strategyNonce);
        previewJson.textContent = JSON.stringify(requestPayload, null, 2);
        const response = await fetch('/api/admin/strategic-briefings/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestPayload) });
        const body = await response.json();
        responseJson.textContent = JSON.stringify(body, null, 2);
        summaryResult.textContent = response.ok ? 'Brief sent successfully' : 'Send needs attention';
        showNotice(response.ok ? 'Brief sent. The signed request and response are available below if you need them.' : (body.error || 'The brief needs attention before it can be sent.'), response.ok ? 'success' : 'error');
      });
    </script>
  </body>
</html>`;
}

export async function handleStrategicBriefingScreen(_request: Request, _env: Env): Promise<Response> {
  return new Response(screenHtml(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
