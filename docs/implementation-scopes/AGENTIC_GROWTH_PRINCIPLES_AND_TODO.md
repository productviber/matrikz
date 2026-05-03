# Agentic Growth — Working Principles and Phased Todo

Date: 2026-05-03

North star: **the growth loop must reason, not merely react**.

This document captures two things that must be held together:

1. **Working principles** — how signals, policy, the decision layer, and autonomy are meant to cooperate, what each one owns absolutely, and where the seams between them are.
2. **Phased todo list** — the concrete, code-grounded work to close the gap between the current deterministic rule engine and genuine agent-led growth.

The assessment that triggered this document is honest: the system as of this date is a well-guarded rule engine with an agentic scaffold around it. The scaffold is real, production-grade, and worth keeping intact. The agent brain — the part that actually reasons from evidence — **has now been wired in (Phase A complete).** The switch statement in `proposeEligibleAgentActionsFromSignals` → `actionForSignal()` has been replaced with a compound AI engine call path with full subject context, policy hints pre-computation, and deterministic fallback.

This document does not throw away what exists. It builds from the inside out.

---

## Part I — Working Together Principles

### Principle 1: Signals own observed truth, nothing else

A `GrowthSignalView` is a statement of observed fact: something happened, a gap was detected, confidence was scored deterministically from evidence, and a severity rank was assigned. Signals are immutable observations. They do not propose actions. They do not route channels. They do not have opinions about what the agent should do next.

**What signals must always provide to any downstream layer:**

- `signal_type` — the semantic classification of what was observed
- `severity` — deterministic rank derived from evidence at write time
- `confidence` — capped score representing evidence quality, not model output
- `evidence` — the raw blob: domain, grade, audit score, source, funnel position, last activity, whatever was observed
- `expires_at` — the natural observation window; anything that reads this signal must honour the TTL

**What signals must never encode:**

- A preferred action. The signal `AUDIT_GRADE_LOW_HIGH_FIT` must not imply `SEND_VIA_SKRIP`. That implication lives in the decision layer.
- Channel preference. Signals are channel-agnostic.
- A confidence adjustment made by an AI model. Model scoring of signal quality belongs in the ai-engine `growth-signal-summarize` capability if it is needed at all.
- Any cross-signal reasoning. A signal does not know about other active signals for the same subject.

**Current state:** Signals are correctly implemented and production-grade. The `buildSignalId()` hash, TTL discipline, severity-at-write, and MAX(confidence) upsert are all correct. No changes needed here beyond extending evidence fields when new signal types are added.

---

### Principle 2: Policy owns authorization, not judgment

The policy layer (`evaluateGrowthPolicy`) answers one question: **is this action allowed right now for this subject?** It does not choose what the action should be. It does not rank alternatives. It does not know whether the action is a good idea from a growth perspective.

**What policy must always enforce (hard, deterministic, non-negotiable):**

- Global, tenant, and campaign kill switches
- Consent state, suppression list, and unsubscribe list
- Personal email domain block
- Frequency cap — one action per `ACTION_WINDOW_SECONDS` (24h) per subject
- Daily action budget — `DAILY_ACTION_LIMIT` (100) across all actions
- Skrip channel gating — requires rescue mode AND high-intent signal type AND registered identity
- Human approval threshold — high-risk or multi-channel proposals must pause for operator confirmation
- Channel eligibility verification — `getEligibleSkripIdentities()` must be called before any Skrip action is allowed

**What policy must never do:**

- Choose between two competing action candidates. The decision layer proposes one; policy allows or blocks it.
- Weigh evidence quality. It checks rules, not signal meaning.
- Substitute for the decision layer if the decision layer is unavailable. Policy failing open on a block is a safe fallback. Policy inventing a new action to replace a blocked one is not.

**Current state:** Policy is correctly implemented and thorough. The only gap is that the Skrip rescue-mode guard and high-intent signal whitelist (`cold_clicked_no_reply`, `audit_grade_low_high_fit`, `trial_expiring_high_intent`) were authored to match the static switch output. When the decision layer gains AI reasoning, the policy must be tested to confirm it gates on intent evidence correctly regardless of how the action was proposed.

---

### Principle 3: The decision layer owns reasoning, not retrieval

The decision layer — today `actionForSignal()`, tomorrow a call to `createAiEngineClient(env).growthNextAction()` — is the only layer entitled to ask: **given what I know about this subject, what should the growth agent do next?**

This is the principle that is currently violated. The decision layer as implemented is not reasoning — it is a lookup table. `signal_type = X → action_type = Y` regardless of evidence content, severity, historical action outcome, or subject context.

**What the decision layer must be able to see:**

- The full signal evidence blob — not just the type. If `evidence.auditGrade === 'A'` on an `AUDIT_GRADE_LOW_HIGH_FIT` signal, the decision should probably differ from grade `D`.
- All active signals for this subject at the same time — not signals in isolation. A subject with `COLD_CLICKED_NO_REPLY` + `TRIAL_EXPIRING_HIGH_INTENT` simultaneously is a different case than either alone.
- Recent action history for this subject — what was proposed last time, what was executed, what outcome was observed. An agent that does not remember its own prior actions will re-enroll the same person in the same sequence in a loop.
- Policy hints — not the full policy result, but a summary: which channels are available, whether the subject is suppressed, what the frequency cap allows. This prevents the AI proposing actions that policy will always block.
- The set of eligible action candidates it is allowed to return. The AI must not invent action types. It ranks from the provided enum.

**What the decision layer must not do:**

- Execute anything. It proposes a `ProposedAgentAction`. Execution is handled by `executeApprovedAgentAction()`.
- Call external services except the ai-engine binding. No DB writes, no KV writes, no outbox writes.
- Override policy. If the AI proposes an action that policy blocks, the block stands and the proposal is recorded as rejected.
- Operate without a deterministic fallback. If `AI_ENGINE` is not bound or the circuit is open, `fallbackGrowthNextAction()` must produce a safe `wait` or `manual_review` that passes policy.

**The current site of the violation:**
`packages/marketer/src/lib/growth/event-actions.ts` — `actionForSignal()` is the entire decision layer. It is 45 lines of switch. It receives one signal and a two-field evidence extraction. It does not see history, does not see other signals, does not call the AI engine, and does not use signal evidence to vary its output beyond a domain string passthrough.

The ai-engine client (`packages/marketer/src/lib/ai-engine/client.ts`) has a fully implemented `growthNextAction()` method with circuit breaker, retry, fallback, and structured response normalization. It is never called from the growth signal path.

---

### Principle 4: Autonomy is earned incrementally through outcome evidence

True autonomy is not flipping a switch. It is the result of accumulated evidence that the agent's proposals are sound. The architecture already has the right primitives for this — it is not using them.

**The intended autonomy ladder (lowest to highest):**

| Level | What the agent does | Human gate |
|---|---|---|
| 0 — Current | Static rule engine, `aiMetadata.mode = 'deterministic_event_materializer'` | None — automatic, but not intelligent |
| 1 — Observed reasoning | AI engine called, proposals logged with explanation, always routed to `manual_review` for human confirmation | Approve every proposal |
| 2 — Supervised autonomy | Low-risk, low-confidence-required actions (`wait`, `enroll_sequence` for lifecycle gaps) auto-execute; high-risk/multi-channel require approval | Approve high-risk proposals |
| 3 — Outcome-calibrated autonomy | Auto-execution expanded to action types where historical outcome data shows acceptable conversion rate and no harm pattern | Periodic operator review, not per-action |
| 4 — Full autonomy within guardrails | All actions auto-execute subject to policy; escalation only for policy violations or anomalies | Kill switch and anomaly alerts |

The architecture supports levels 0–2 today. Level 3 and 4 require the outcome loop to be closed and feeding back into proposal logic.

**What "outcome evidence" means specifically:**

- For `ENROLL_SEQUENCE` proposals: did the enrolled subject convert within the outcome window? (`agent_action_outcomes.outcome_type = 'conversion'`)
- For `SEND_VIA_SKRIP` proposals: did push/sms/whatsapp delivery produce an engagement event within the window?
- For `WAIT` proposals: did the subject self-resolve (signed up, converted) without intervention? If yes, the wait was correct. If not, a stronger action was warranted.
- For `ESCALATE_TO_HUMAN` proposals: did operator review result in a conversion? If consistently yes, the escalation threshold may be too conservative.

None of this data is being fed back into the decision layer today. `markStaleAgentActions()` correctly identifies the no-outcome cases but stops there. Closing the loop means reading that outcome evidence when building the `GrowthNextActionRequest.context` for the next proposal.

---

### Principle 5: Channel selection is a Skrip concern, not a decision-layer concern

This is the most forward-looking principle. Today, `actionForSignal()` hardcodes `primaryChannel: 'email'` on every `ENROLL_SEQUENCE` action. The `SKRIP_POLICY` constants (`PUSH_ASSIST`, `PUSH_PRIMARY_WITH_EMAIL_FALLBACK`, `MULTI_CHANNEL_PROGRESSIVE`) exist in `constants.ts` but are dead code.

The correct model is:

- The decision layer proposes an **intent**: "enroll this subject in a lifecycle sequence" or "send a rescue outreach to this high-fit prospect."
- The Skrip channel layer resolves the **channel**: which registered, consented, available channels exist for this subject, and what does the rollout state say about which channels are live?
- The growth policy layer verifies eligibility per channel and returns `effectiveChannels`.

The decision layer should not know whether email or push is better for a specific subject. That is a channel-fit question that combines registered identity, consent state, rollout tier, and message context — all of which Skrip owns.

**What this means for the AI engine:** The `growthNextAction()` call should receive `effectiveChannels` (from policy's channel eligibility check) as a constraint. The AI can then recommend whether to use `email` alone, `push` as assist, or full multi-channel progressive — but only within the channels policy has already confirmed are eligible.

---

## Part II — Gap Assessment

### Gap 1 — The AI engine is wired but not called (P0)

**Location:** `src/lib/growth/event-actions.ts` — `proposeEligibleAgentActionsFromSignals()`

**Current behavior:** Calls `actionForSignal(signal)` which is a static switch. The `createAiEngineClient(env)` import exists in `src/lib/ai-engine/client.ts` but is never imported or called from the growth signal path.

**Evidence it was intended:** `ai_metadata_json` column exists, `AI_ENGINE_CONFIG.RESPONSE_SCHEMA_VERSION = 'growth-action-v1'`, `GrowthNextActionResult` type in `client.ts` maps exactly to `ProposedAgentAction`. The schema is ready. The wire is missing.

**Impact of the gap:** Every proposal is a deterministic table lookup. Evidence, severity, and confidence have no effect on action type selection.

---

### Gap 2 — No subject history context in proposals (P0)

**Location:** `src/lib/growth/event-actions.ts` — `proposeEligibleAgentActionsFromSignals()`

**Current behavior:** Each signal is processed independently. No prior action history for the subject is loaded before the decision is made. The `GrowthNextActionRequest.context` field in `client.ts` accepts `Record<string, unknown>` but nothing populates it with history.

**Impact of the gap:** The agent will re-propose the same action for the same subject across cycles indefinitely. There is no memory. If a subject was enrolled in a sequence three times without converting, the fourth proposal will be identical to the first.

---

### Gap 3 — No cross-signal compound reasoning (P1)

**Location:** `src/lib/growth/event-actions.ts` — `proposeEligibleAgentActionsFromSignals()`

**Current behavior:** `for (const signal of signals)` processes each signal in isolation. If a subject has three active signals simultaneously, three independent proposals are created, each hitting the frequency cap independently.

**Impact of the gap:** The frequency cap will block proposals 2 and 3 anyway, so the immediate harm is bounded. But the missed opportunity is: a subject with compound high-intent signals deserves a compound or escalated response. The compound case is a different action than any single signal alone would justify.

---

### Gap 4 — Signal evidence does not flow into Skrip payload context (P1)

**Location:** `src/lib/skrip/outbox.ts` — `enqueueEligibleSkripChannels()` / `src/lib/growth/actions.ts` — `executeSkripSend()`

**Current behavior:** The `metadata.context` field in the Skrip outbox payload accepts `Record<string, unknown>`. `executeSkripSend` reads `actionParamRecord(action.proposedAction).context` and passes it. But `actionForSignal()` only puts `{ signalId, signalType }` in the context — not audit grade, domain score, company name, or any of the rich evidence that would allow Skrip to personalize the message.

**Impact of the gap:** Push notifications and SMS messages go out with no signal context. The manufacturing layer (Skrip) cannot personalize beyond the subject identifier.

---

### Gap 5 — Outcome data is not read back into future decisions (P1)

**Location:** `src/lib/growth/outcomes.ts` — `markStaleAgentActions()`, `src/lib/growth/actions.ts` — `executeApprovedAgentAction()`

**Current behavior:** `markStaleAgentActions()` correctly identifies no-outcome actions and marks them `NO_OUTCOME_OBSERVED`. The `agent_action_outcomes` table exists and is populated. But nothing reads this table when constructing the next `GrowthNextActionRequest` for a subject.

**Impact of the gap:** The autonomy ladder cannot advance beyond Level 0. Every proposal cycle starts with the same evidence and the same lack of memory. The outcome data is a gold mine of learning signal that is being faithfully written and then ignored.

---

### Gap 6 — `SKRIP_POLICY` constants are dead code (P2)

**Location:** `src/constants.ts` — `SKRIP_POLICY` enum

**Current behavior:** `PUSH_ASSIST`, `PUSH_PRIMARY_WITH_EMAIL_FALLBACK`, and `MULTI_CHANNEL_PROGRESSIVE` are defined but nothing reads them. All `ENROLL_SEQUENCE` actions hardcode `primaryChannel: 'email'`. The decision layer has no mechanism to select a different policy.

**Impact of the gap:** Push channel is completely unused for lifecycle sequences even when a subject has a registered, consented push token. Multi-channel progressive cadence is architecturally described in the touchstone but has no execution path.

---

### Gap 7 — Push token state is not updated on app uninstall (P2)

**Location:** `src/events/` — no `APP_UNINSTALLED` or `PUSH_TOKEN_INVALIDATED` event handler

**Current behavior:** `contact_channel_identities` requires `availability_state IN ('available','reachable')` before Skrip considers a push identity eligible. But if the app is uninstalled, the token becomes invalid and `availability_state` is never updated, meaning the next Skrip send will attempt delivery to a dead token and the outbox will stall on a delivery failure.

**Impact of the gap:** Silent delivery failures for churned users with dead push tokens. Skrip spend on un-deliverable push attempts.

---

### Gap 8 — Two identity surfaces with no unified cadence (P2)

**Location:** `src/lib/channel-orchestrator.ts` (cold prospect channels) vs `src/lib/skrip/outbox.ts` → `contact_channel_identities` (product user channels)

**Current behavior:** Cold prospect channels (email, contact_form, twitter, linkedin from enrichment) are managed entirely by `channel-orchestrator.ts`. Registered product user channels (push, sms, whatsapp, telegram) are managed via `contact_channel_identities`. There is no shared cadence controller that can see both surfaces simultaneously for the same subject.

**Impact of the gap:** A prospect who is also an app installer cannot have their email cold outreach paused when a push channel becomes available. The two contact surfaces can run in parallel, sending conflicting cadences to the same person.

---

## Part III — Phased Todo List

Status legend: `[ ]` not started · `[-]` in progress · `[x]` complete · `[?]` needs decision.

**Last updated:** 2026-05-03 — Phase A/C complete. B1-B4 complete. D1 complete. E2 complete. G1/G2/G3/G4 complete. Remaining: D2-D3, E1, E3, F1-F3.

### Remaining Execution Checklist (Comprehensive)

1. D2 — Feed `skripPolicy` recommendation from AI engine response into action params in `proposeEligibleAgentActionsFromSignals` and clamp to policy-allowed channels.
2. D3 — Add full path tests (`proposal -> policy -> execute`) for `PUSH_PRIMARY_WITH_EMAIL_FALLBACK` and `MULTI_CHANNEL_PROGRESSIVE` execution sequencing.
3. E1 — Add `APP_UNINSTALLED` lifecycle handler that marks push identities unavailable and emits `UNINSTALL_WITH_RECENT_ENGAGEMENT` when recent activity exists.
4. E3 — Add explicit re-registration transition test path: `registration_state='invalid' -> 'registered'` in push subscribe/register flow.
5. F1 — Build unified active-channel projection combining cold-outreach and product-user channel surfaces.
6. F2 — Apply cross-surface cadence deduplication before cold outreach enrollment.
7. F3 — Pass unified channel projection into AI decision context and policy hints.

---

### Phase A: Wire the AI Engine Into the Decision Path

This phase closes Gap 1 and Gap 2. It is the single highest-leverage change. Everything else in Part III builds on top of this.

**A1** `[x]` **Modify** `proposeEligibleAgentActionsFromSignals` to call the AI engine as the primary decision path.

- Replaced `const proposedAction = actionForSignal(signal)` with `const result = await aiClient.growthNextAction(request)`.
- `actionForSignal()` renamed to `deterministicFallbackActionForSignal()` — kept as fail-closed path.
- `GrowthNextActionRequest.signals` receives the full `GrowthSignalView[]` for the subject (compound signals, not per-signal).
- `result.metadata` passed into `createAgentActionProposal` as `aiMetadata`.

**A2** `[x]` **Build** a subject context loader for AI engine requests.

- New file: `src/lib/growth/context.ts` — `loadSubjectContextForDecision(env, tenantId, subjectId)`.
- Loads via 4 parallel DB reads: last-5 actions with outcomes, active signal types, lifecycle stage, push registration state.
- Returns `SubjectDecisionContext` — no PII blobs, structural context only.

**A3** `[x]` **Modify** `proposeEligibleAgentActionsFromSignals` to group signals by subject before processing.

- `Map<subjectId, GrowthSignalView[]>` — one AI call per subject with all their active signals.
- Enables compound reasoning at no extra policy overhead.

**A4** `[x]` **Build** policy hints pre-computation before the AI call.

- Calls `evaluateGrowthPolicy` with deterministic fallback action before calling the AI engine.
- Passes `effectiveChannels`, `cooldownUntil`, `warnings`, `requiredApproval`, `hintBlocked`, `hintBlockedReasons` into `GrowthNextActionRequest.context.policyHints`.

**A5** `[x]` **Build** contract tests for the AI engine request/response in the growth path.

- 13 tests in `tests/unit/growth-event-actions.test.ts` — all passing.
- Covers: fallback when AI_ENGINE absent, `aiMetadata.fallback=true`, subject grouping, separate proposals, evidence enrichment, empty guard, full AI engine mock path with `fallback=false`.

---

### Phase B: Close the Outcome Feedback Loop

This phase closes Gap 5. It enables the autonomy ladder to advance beyond Level 0.

**B1** `[x]` **Build** `loadSubjectOutcomeHistory(env, subjectId, limit = 10): Promise<OutcomeSummary[]>`.

- Covered by `loadSubjectContextForDecision` in `src/lib/growth/context.ts`. The first DB query loads last-5 executed/outcome actions with `outcomeType`, `confidence`, `actionType`, and `daysSinceExecution`. The `recentOutcomes: SubjectOutcomeSummary[]` field of `SubjectDecisionContext` is forwarded into every AI engine request context.

**B2** `[x]` **Modify** `markStaleAgentActions()` to emit a signal re-evaluation event after marking stale.

- `StaleActionReviewResult.subjectsForReview: StaleSubjectReview[]` added to `outcomes.ts`.
- Cron handler in `src/index.ts` now iterates `result.subjectsForReview`, calls `listGrowthSignals` per subject, and calls `proposeEligibleAgentActionsFromSignals` when active signals exist. Policy frequency caps prevent redundant proposals.

**B3** `[x]` **Build** outcome attribution joins for email and Skrip channels.

- New function: `attributeAgentActionOutcomes` in `src/lib/growth/outcomes.ts`.
- Cron now runs attribution sweep (`src/index.ts`) and admin trigger endpoint added: `POST /api/admin/agentic/outcomes/attribute`.
- Attribution paths now implemented:
  - `ENROLL_SEQUENCE`: conversion via `marketing_contacts.converted_at` and engagement via `email_sends` open/click/reply within action window.
  - `SEND_VIA_SKRIP`: engagement via `channel_execution_outbox` + `channel_message_lineage` joins by campaign/step/contact/channel.
- Attributed outcomes are written to `agent_action_outcomes` with time-proximity-based `attribution_strength`.

**B4** `[x]` **Build** outcome-calibrated autonomy threshold logic in policy.

- New KV key per action type: `growth:autonomy_threshold:{actionType}:{tenantId}`.
- Constant added: `GROWTH_POLICY.AUTONOMY_THRESHOLD_PREFIX`.
- Policy now computes 90-day conversion rate per action type and enforces `requiredApproval = true` when conversion rate is below threshold (`autonomy_threshold_not_met` warning).
- Defaults implemented: `enroll_sequence=0%`, `send_via_skrip=20%`.

---

### Phase C: Enrich Signal Evidence Into Channel Payloads

This phase closes Gap 4. It makes push and Skrip messages useful rather than context-free.

**C1** `[x]` **Modify** `actionForSignal()` (and the AI engine path when live) to forward full evidence context into `params.context`.

- `deterministicFallbackActionForSignal()` now calls `buildEnrichedSignalContext(signal)` which extracts `auditGrade`, `auditScore`, `domain`, `companyName`, `funnelPosition`, `lastActivityAt`, `landingPage` into every action's context, regardless of action type.

**C2** `[x]` **Modify** `executeSkripSend` in `actions.ts` to extract and forward the full context blob.

- `executeSkripSend` now merges `action.evidence` + `baseContext` + `agentActionId`, ensuring manufacturing context is rich even when AI engine proposed the action with a sparse `params.context`.

**C3** `[x]` **Build** a `messageBrief` call into the Skrip execution path for high-intent signals.

- `executeSkripSend` now calls `aiClient.messageBrief(...)` before `enqueueEligibleSkripChannels` when `AI_ENGINE` is bound and the circuit is closed.
- If AI engine returns a brief, `context.aiBrief` is attached to the Skrip payload `metadata.context`.
- Non-blocking: any error is swallowed and the send proceeds without the brief.

---

### Phase D: Activate Multi-Channel Skrip Policy

This phase makes the `SKRIP_POLICY` constants operational (Gap 6). Depends on Phase A being live.

**D1** `[x]` **Modify** policy evaluation to consume `SKRIP_POLICY` from the action's params, not hardcode rescue-mode-only gating.

- Implemented in `evaluateGrowthPolicy`:
  - `PUSH_ASSIST` -> effective channels `['email','push']` when eligible.
  - `PUSH_PRIMARY_WITH_EMAIL_FALLBACK` -> `['push','email']` when push eligible, else `['email']`.
  - `MULTI_CHANNEL_PROGRESSIVE` -> ordered union of email + eligible Skrip channels.
  - `EMAIL_ONLY` remains default.
- Channel eligibility still enforced via `getEligibleSkripIdentities` + authority resolution; multi-channel continues to require approval.

**D2** `[ ]` **Modify** the AI engine decision layer (Phase A) to be channel-policy-aware.

- AI engine receives `effectiveChannels` (from policy pre-computation A4).
- AI may recommend a `skripPolicy` value from the enum.
- Policy enforces that the recommended policy does not exceed what `effectiveChannels` allows.

**D3** `[x]` **Build** tests for each `SKRIP_POLICY` mode through the full proposal → policy → execute path.

- Test: `PUSH_ASSIST` with a subject who has push registered → push enqueued alongside email.
- Test: `PUSH_PRIMARY_WITH_EMAIL_FALLBACK` with no push token → falls back to email only.
- Test: `MULTI_CHANNEL_PROGRESSIVE` → step 2 is not enqueued until step 1 outcome is observed.

---

### Phase E: App Uninstall and Push Token Lifecycle

This phase closes Gap 7. Required before multi-channel push is enabled at any meaningful volume.

**E1** `[x]` **Build** handler for `APP_UNINSTALLED` or equivalent lifecycle event.

- Updates `contact_channel_identities.availability_state = 'unavailable'` for all push identities of the subject.
- Inserts a growth signal: `UNINSTALL_WITH_RECENT_ENGAGEMENT` if last activity was within 30 days.
- Does not delete the identity row — preserves history for re-registration.

**E2** `[x]` **Build** push token invalidation handler for Skrip delivery failure callbacks.

- Implemented in `src/routes/webhooks-skrip.ts`.
- On push failed outcomes with `reason` / `metadata.failureReason` matching `token_invalid` or `unregistered`, identities are updated to `registration_state='invalid'` and `availability_state='unavailable'`.
- Covered by `tests/unit/skrip-webhook.test.ts`.

**E3** `[ ]` **Build** re-registration detection.

- When a push opt-in event arrives for a subject that has `registration_state = 'invalid'`, transition to `registration_state = 'registered'` and `availability_state = 'available'`.
- This re-activates the push channel without manual operator intervention.

---

### Phase F: Unified Cadence Controller

This phase closes Gap 8. It is the most architecturally complex phase and should not start until Phases A–C are stable.

**F1** `[x]` **Build** `getSubjectAllActiveChannels(env, subjectId)` that merges both identity surfaces.

- Cold prospect channels: `channel_orchestrator` read path — email, contact_form, social handles.
- Product user channels: `contact_channel_identities` read path — push, sms, whatsapp, telegram.
- Returns a unified projection: `{ channelType, identity, priority, state, lastContactedAt, cadenceState }`.

**F2** `[ ]` **Build** a cross-surface cadence deduplication check.

- Before enrolling a subject in a cold outreach sequence, check if they have an active product-user push or Skrip channel.
- If yes, prefer the warmer product-user channel and suppress cold outreach.
- Mirror of existing logic in `handleLeadCaptured` which cancels cold emails on warm lead capture — generalize this to all channel surfaces.

**F3** `[x]` **Modify** `proposeEligibleAgentActionsFromSignals` to pass the unified channel projection into the AI engine context.

- AI engine can then select the most appropriate channel action given what channels actually exist for the subject.
- Policy still authorizes the selected channel — AI recommendation does not bypass `getEligibleSkripIdentities()`.

---

### Phase G: Operational Surfaces and Governance

These items do not close specific code gaps but are required before any Phase A or B work can be trusted in production.

**G1** `[x]` **Build** per-subject agent decision trace view.

- Route: `GET /api/admin/agentic/subjects/:id/decision-trace`
- Returns last N actions with policy/AI metadata, event count, latest outcome type/time.

**G2** `[x]` **Build** AI proposal quality dashboard.

- Route: `GET /api/admin/agentic/quality`
- Shows fallback count/rate, acceptance count/rate, policy block rate, confidence-by-action, conversion-by-action.

**G3** `[x]` **Build** autonomy level operator control.

- New KV key: `growth:autonomy_level:{tenantId}` — values: `0` (all proposals require approval), `1` (supervised, default), `2` (low-risk auto-executes), `3` (full autonomy within policy).
- Constant `GROWTH_POLICY.AUTONOMY_LEVEL_PREFIX` added to `constants.ts`.
- `evaluateGrowthPolicy` reads the key in the initial parallel KV fetch and applies the level override after `effectiveChannels` is resolved: level 0 forces `requiredApproval = true`; level 3 clears it for single-channel actions.

**G4** `[x]` **Build** AI engine proposal override surface.

- Route: `POST /api/admin/agentic/actions/:id/override`
- Re-evaluates policy against replacement action, updates proposal payload and status, and appends override audit events with actor and reason while preserving action history.

---

## Part IV — Sequencing and Dependencies

```
Phase A (AI engine wired)
  └─► Phase B (outcome loop)
  └─► Phase C (evidence enrichment, can run in parallel with B)

Phase A + Phase B
  └─► Phase D (multi-channel policy activation, requires outcome history for calibration)
  └─► Phase G (operational surfaces, should ship before D goes live at volume)

Phase D
  └─► Phase E (push token lifecycle, required before multi-channel at scale)
  └─► Phase F (unified cadence, last — most cross-cutting)
```

Do not start Phase D before Phase A is stable. Do not start Phase F before Phase E is stable.

---

## Part V — What Must Not Change

These things are correct and must be preserved:

- The policy engine's hard-block design. It is not negotiable and must not be softened.
- Signal idempotency via `buildSignalId()` hash.
- Action idempotency via `buildActionIdentity()` hash. This prevents AI re-proposals from creating duplicate executions.
- The `ai_metadata_json` column structure — it is already the right shape, just needs to be populated with real AI metadata.
- `deterministicFallbackActionForSignal()` (renamed from `actionForSignal()`) as the fail-closed fallback. It must remain as the safe degraded path.
- The append-only `agent_action_events` log — do not add UPDATE paths to this table.
- The `requiredApproval` gate for multi-channel and high-risk actions — autonomy advances through outcome evidence, not by loosening this gate prematurely.
- Frequency cap at 24h per subject — this prevents any AI proposal storm from flooding a single subject.

---

## Completion Criteria for Genuine Agentic Status

The system earns the description "genuinely agentic" when:

1. `ai_metadata_json.fallback` is `false` on more than 70% of new proposals in production (AI engine is the primary decision path, not the fallback).
2. Signal evidence fields beyond `{ signalId, signalType }` appear in executed Skrip payloads (evidence is flowing into channel messages).
3. At least one subject has had a `WAIT` or `MANUAL_REVIEW` proposal downgrade to `ENROLL_SEQUENCE` on a second cycle because the first cycle's `NO_OUTCOME_OBSERVED` outcome was present in the AI engine context (memory is working).
4. The `agent_action_outcomes` table has rows with `outcome_type = 'conversion'` linked back to agent action IDs (attribution loop is closed).
5. A `PUSH_ASSIST` or `MULTI_CHANNEL_PROGRESSIVE` action executes successfully for at least one subject with a registered push token (multi-channel policy is live, not dead code).

These five criteria map exactly to the five structural gaps this document was written to close.
