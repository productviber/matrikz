# Ecosystem Alignment Review — 2026-05-04

Date: 2026-05-04
Scope: Cross-repo review of Matrikz growth-agent, Visibility Marketing, and Skrip
Purpose: Record the current alignment judgment, responsibility boundaries, maturity stage, and the concrete improvements required to move from a decision API to a closed-loop optimizer.

## Executive Summary

Current judgment:

- The ecosystem is directionally aligned.
- Authority boundaries are mostly correct.
- The Matrikz growth-agent is functioning as a structured decision API, not as an autonomous growth operator.
- Visibility Marketing is functioning as the growth orchestration and policy layer.
- Skrip is functioning as the message manufacturing, channel identity, and delivery layer.
- Remaining risk is now mostly integration closure, contract clarity, and operational certification rather than architectural confusion.

## Responsibility Boundary

### Matrikz growth-agent

Owns:

- structured growth reasoning,
- schema-validated capability outputs,
- model/provider failover,
- deterministic fallback envelopes,
- capability-level telemetry for advisory requests.

Must not own:

- channel execution,
- campaign orchestration,
- consent/suppression truth,
- conversion truth,
- long-horizon autonomous optimization.

### Visibility Marketing

Owns:

- growth lifecycle and campaign orchestration,
- policy and guardrail enforcement,
- agent action ledger and audit trail,
- attribution and growth outcome interpretation,
- authority resolution for whether a send remains local or is delegated to Skrip.

Must not own:

- channel canonical identity truth,
- message manufacture internals,
- provider/model routing,
- product conversion truth.

### Skrip

Owns:

- channel identity and reachability,
- message manufacture and validation,
- provider dispatch and retry,
- delivery outcome normalization,
- signed webhook return path,
- channel conversation state where delivery memory is required.

Must not own:

- growth campaign decisions,
- growth eligibility policy,
- product adoption decisions,
- domain conversion truth.

## Evidence-Based Alignment Findings

### What is aligned now

1. Visibility Marketing resolves a single send authority per tenant, campaign, and channel before queuing any outbound action.
2. Visibility Marketing preserves growth lineage into Skrip handoff payloads, including `agentActionId`, `growthCapability`, `promptVersion`, and `responseSchemaVersion`.
3. Skrip exposes a stable internal strategic execution contract and returns deterministic response envelopes with delivery mode and degraded reasons.
4. Skrip outcomes are returned to Visibility Marketing through a signed webhook path and are linked back to growth actions.
5. Matrikz growth-agent is correctly scoped as advisory infrastructure with deterministic fallbacks and schema discipline.

### What is not fully closed yet

1. Cross-worker staging validation is still described as pending in scope docs even though local harnesses and release-scope smoke evidence exist.
2. Visibility Marketing can emit channel preferences that include `email` in contexts where Skrip strategic send only supports `push`, `whatsapp`, `telegram`, and `sms`.
3. The system still has two execution shapes for `send_via_skrip`: direct strategic send and outbox-based handoff. This is pragmatic, but it increases incident and certification complexity.
4. Skrip still has pending integration work around routing audit integration, outcome join jobs, reconciliation surfaces, and manufacturer telemetry closure.
5. Matrikz growth-agent is currently consumed most concretely through `growth-next-action`; the broader capability surface exists but is not yet fully exercised as a production control plane.

## Capability Maturity Model

### Stage 1 — Decision API

Definition:

- AI returns structured growth recommendations or analysis.
- Deterministic systems remain responsible for execution.

Current status:

- Matrikz growth-agent is already operating at this stage.

Evidence:

- five structured capabilities exist,
- response envelopes are stable,
- schema validation and fallback behavior are implemented,
- provider failover and observability are in place.

### Stage 2 — Closed-Loop Optimizer

Definition:

- the system can observe signals,
- decide a growth action,
- execute through a governed delivery path,
- ingest outcomes,
- and use those outcomes to improve future decisions.

Current status:

- The ecosystem is partially here, but not fully certified.

Evidence already present:

- Visibility Marketing has the policy engine, action ledger, execution tracing, and attribution projections.
- Skrip has manufacturing contracts, v1 send surfaces, signed outcome webhooks, and delivery normalization.
- Matrikz growth-agent provides structured recommendation capabilities needed for the advisory layer.

What still blocks full Stage 2 closure:

- a single certified live-contract staging path across Marketing -> Skrip -> normalized outcomes,
- clarified channel-support contract for strategic send,
- narrowed execution-lane complexity for `send_via_skrip`,
- semantic quality gates and broader capability consumption,
- complete outcome learning and telemetry instrumentation across all participating systems.

### Stage 3 — Autonomous Growth Operator

Definition:

- the system can safely optimize strategy over time with governance, evaluation, rollout controls, and durable learning.

Current status:

- The ecosystem is not here yet.

Missing characteristics:

- formal shadow-routing and semantic eval promotion loops,
- stronger online review of action quality by capability and prompt version,
- more complete stage-gated automation governance,
- mature cross-repo control of strategy adaptation.

## Concrete Improvement Flags By Repository

### Matrikz growth-agent

Improve or change:

1. Strengthen semantic evaluation beyond schema validity, starting with `growth-next-action`, then `message-brief`, then `outcome-diagnose`.
2. Add live staging certification evidence for all five capabilities, not only local/unit/integration coverage.
3. Tighten its role as an advisory plane by documenting and testing that callers must execute only deterministic, pre-authorized actions.
4. Expand quality and version governance so prompt changes, model changes, and schema changes can be promoted under explicit rollout rules.
5. Support broader real-world usage by downstream consumers so the full capability surface is exercised, not just `growth-next-action`.

### Visibility Marketing

Improve or change:

1. Reduce ambiguity around `send_via_skrip` by choosing one canonical execution lane for operator reasoning and release certification.
2. Normalize channel preferences before building Skrip strategic requests so unsupported channels are not passed silently.
3. Promote the full live-contract staging path to a release gate rather than leaving it as partially operational signoff.
4. Increase direct use of additional advisory capabilities beyond next-action, especially `message-brief` and `outcome-diagnose`.
5. Keep ownership strict: Marketing decides, approves, and attributes; it should never drift toward provider-specific message manufacturing.

### Skrip

Improve or change:

1. Publish an explicit supported-channel contract for strategic send and return clear downgrade or rejection behavior.
2. Complete the pending routing audit integration, telemetry closure, and outcome join job.
3. Finish channel identity reconciliation and canonical projection surfaces for Marketing.
4. Preserve the deterministic shell while converging manufacturer paths and removing direct-provider legacy branches once parity is proven.
5. Keep domain-pack boundaries hard so vertical assumptions do not leak back into generic runtime paths.

### Cross-product / platform

Improve or change:

1. Create one shared live-contract certification standard for Marketing -> Skrip and Marketing -> Matrikz growth-agent.
2. Standardize cross-system trace fields so `correlationId`, `agentActionId`, capability, delivery mode, and outcome lineage can be stitched without ad hoc joins.
3. Formalize the supported transition from Stage 1 to Stage 2 with release gates, operator runbooks, and semantic quality thresholds.

## Recommended Next Priority

1. Certify one canonical cross-worker staging path end-to-end and treat it as a required release gate.
2. Resolve the strategic channel-support mismatch and document downgrade behavior.
3. Narrow `send_via_skrip` execution semantics so there is one primary operational path and one explicit fallback path.
4. Add semantic quality thresholds and shadow-routing discipline on the advisory side.
5. Expand the closed-loop reporting path so outcomes are reviewed by capability, prompt version, strategy version, and channel.