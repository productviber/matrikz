# ai-engine Implementation Todo

Date: 2026-05-02

Role: **Shared Structured Inference And Evaluation Plane**.

ai-engine should provide model-powered reasoning, summarization, classification, drafting, evaluation, and critique. It should not execute growth actions, mutate campaigns, send messages, or become the owner of product/adoption truth.

Target split:

```text
Deterministic shell: 50-70%
Model inference:     30-50%
```

## Authority Boundary

ai-engine owns:

- provider/model registry,
- provider fallback and capability routing,
- structured response parsing and validation,
- usage/cost/quality tracking,
- prompt/capability versioning,
- model-powered capability implementations,
- evaluation and experiment harnesses.

ai-engine consumes:

- product/adoption context from Analytics or Marketing,
- growth signals and deterministic candidates from Marketing,
- message briefs or manufacturing requests if Skrip chooses to reuse it,
- redaction and policy hints from calling services.

ai-engine must not own:

- action execution,
- growth policy authorization,
- consent/suppression truth,
- domain conversion truth,
- channel identity.

## Phase 0: Reliability Audit Before Reuse

- `[ ]` **Modify**: Add tests around current provider routing and fallback behavior.
- `[ ]` **Modify**: Audit current capabilities for import/name mismatches and incorrect provider option passing.
  - Known candidates: experiment capability and batch-analyze capability.
- `[ ]` **Modify**: Fix `runCustomPrompt` option naming if it should force a model/provider.
- `[ ]` **Modify**: Fix experiment comparison calls so provider keys/environment are preserved.
- `[ ]` **Modify**: Fix batch capability imports to match actual route/capability exports.
- `[ ]` **Build**: Add startup capability manifest validation.
  - Ensures every manifest entry maps to a route and implementation.
- `[ ]` **Build**: Add response schema tests for every capability.
- `[ ]` **Build**: Add provider unavailable tests.
  - Must prove failover and free/cheap fallback behavior.

Determinism: 80-90% deterministic hardening, 10-20% provider behavior.

## Phase 1: Growth Capability Contracts

- `[ ]` **Build**: Add `growth-next-action` capability.
  - Input: deterministic signals, eligible action candidates, subject context, policy hints.
  - Output: ranked action enum, confidence, evidence, risks, required guards, fallback action.
- `[ ]` **Build**: Add `growth-signal-summarize` capability.
  - Output: concise operator explanation; no new facts.
- `[ ]` **Build**: Add `journey-critic` capability.
  - Reviews a proposed journey/action for contradictions, risk, and missing evidence.
- `[ ]` **Build**: Add `message-brief` capability.
  - Converts product/growth context into a manufacturing brief for Skrip, not final channel payload unless explicitly requested.
- `[ ]` **Build**: Add `outcome-diagnose` capability.
  - Explains why a growth action underperformed using deterministic outcome metrics.
- `[ ]` **Build**: Add `segment-intelligence` capability.
  - Summarizes deterministic segments and suggests hypotheses.
- `[ ]` **Build**: Add `channel-fit` capability.
  - Advises channel suitability from provided channel projection; Marketing/Skrip still authorize.
- `[ ]` **Build**: Add `variant-hypothesis` capability.
  - Suggests copy/positioning hypotheses based on variant outcomes.

Determinism: 60-70% structured shell, 30-40% model reasoning.

## Phase 2: Structured Output Discipline

- `[ ]` **Build**: Define Zod schemas for all growth capabilities.
- `[ ]` **Build**: Add JSON schema mirrors if provider structured output uses JSON schema.
- `[ ]` **Modify**: Refuse unstructured prose for machine-consumed growth responses.
- `[ ]` **Build**: Add confidence calibration fields.
  - Required: `confidence`, `evidence`, `missingEvidence`, `riskFlags`, `assumptions`.
- `[ ]` **Build**: Add action enum restrictions.
  - ai-engine may rank provided candidates; it may not invent executable operations.
- `[ ]` **Build**: Add deterministic fallback response for every growth capability.
  - Fallback action should usually be `manual_review` or `wait`.
- `[ ]` **Build**: Add schema violation telemetry and model/provider quality scoring.

Determinism: 70-80% deterministic validation, 20-30% model output.

## Phase 3: Service Binding And Auth For Marketing

- `[ ]` **Modify**: Confirm zero-trust auth accepts `visibility-marketing` service binding in all deployed environments.
- `[ ]` **Build**: Add Marketing-specific caller identity and rate bucket.
- `[ ]` **Build**: Add capability-level quotas.
  - Examples: `growth-next-action` lower volume/higher quality; `growth-signal-summarize` higher volume/cheaper model.
- `[ ]` **Build**: Add request classification for cost tier and complexity.
- `[ ]` **Modify**: Ensure no caller can bypass rate limits through service binding trust.
- `[ ]` **Build**: Add signed or correlation-aware request logging for cross-worker tracing.

Determinism: 95% deterministic.

## Phase 4: Prompt And Capability Versioning

- `[ ]` **Build**: Version every growth prompt and response schema.
- `[ ]` **Build**: Add prompt registry metadata.
  - Required: capability, prompt version, schema version, owner, risk level, allowed models, fallback behavior.
- `[ ]` **Build**: Add golden input/output fixtures.
- `[ ]` **Build**: Add regression tests for prompt outputs against schema and core invariants.
- `[ ]` **Build**: Add capability changelog.
- `[ ]` **Remove**: Avoid invisible prompt edits in source without version bump.

Determinism: 85-95% deterministic process, 5-15% model variation.

## Phase 5: Reusable Provider Infrastructure

- `[ ]` **Modify**: Strengthen provider registry with explicit feature support.
  - Examples: structured JSON, tool use, embeddings, low latency, cheap batch, long context.
- `[ ]` **Build**: Add per-capability model preference chains.
- `[ ]` **Build**: Add provider circuit breaker and retry telemetry if not already complete.
- `[ ]` **Build**: Add latency/cost/error dashboards by capability/provider/model.
- `[ ]` **Extract**: Evaluate extracting provider registry to shared package if Skrip should reuse it locally.
- `[?]` **Modify**: Decide network service vs shared library reuse for Skrip.
  - Service reuse centralizes governance but adds latency and availability coupling.
  - Shared library reuse reduces latency but duplicates runtime tracking unless carefully designed.

Determinism: 80% deterministic routing, 20% provider behavior.

## Phase 6: Evaluation And Experiment Harness

- `[ ]` **Build**: Add offline evaluation harness for growth capabilities.
- `[ ]` **Build**: Add labeled evaluation set for next-action recommendations.
- `[ ]` **Build**: Add adversarial tests.
  - Examples: insufficient evidence, contradictory signals, suppressed contact, high-risk action, missing consent, stale events.
- `[ ]` **Build**: Add model comparison report.
  - Compare accuracy, schema validity, refusal behavior, cost, latency.
- `[ ]` **Build**: Add production sampling review workflow.
  - Human review of a safe sample of proposals and explanations.
- `[ ]` **Modify**: Feed Marketing action outcomes back into evaluation, not direct online learning without guardrails.

Determinism: 70-80% deterministic evaluation, 20-30% model comparison.

## Phase 7: Privacy And Redaction

- `[ ]` **Build**: Field-level redaction helper for growth payloads.
- `[ ]` **Build**: Add sensitivity labels to request schema.
- `[ ]` **Modify**: Strip or hash direct identifiers unless a capability explicitly needs them.
- `[ ]` **Build**: Add prompt injection checks for user/domain-provided free text.
- `[ ]` **Build**: Add tenant data isolation tests.
- `[ ]` **Remove**: No raw secrets, provider tokens, private keys, or unrestricted PII in prompts/logs.

Determinism: 100% deterministic.

## Phase 8: ai-engine As Advisor, Not Executor

- `[ ]` **Build**: Add explicit `nonExecutable` metadata to advisory responses.
- `[ ]` **Modify**: Growth capabilities should return `recommendedAction` from caller-provided candidates only.
- `[ ]` **Modify**: Message capabilities should return a brief or draft, not send instructions to providers.
- `[ ]` **Remove**: Do not add endpoints like `/ai/execute-growth-action`, `/ai/send-message`, or `/ai/enroll-campaign`.
- `[ ]` **Build**: Add docs warning callers that ai-engine output requires deterministic policy validation.

Determinism: 100% boundary enforcement.

## Validation Plan

- Unit tests for schemas, parser, provider routing, and fallback responses.
- Capability manifest tests proving route/implementation parity.
- Contract tests with Visibility Marketing.
- Golden tests for growth capabilities.
- Provider unavailable and malformed model output tests.
- Privacy/redaction snapshot tests.
- Cost/rate-limit tests by caller and capability.

## Dependencies

- Marketing must provide deterministic candidate actions and policy hints.
- Analytics must provide product/adoption context in redacted, stable schemas.
- Skrip reuse decision must be made before provider abstraction is centralized.
- Cross-product governance must define model risk levels and approval thresholds.
