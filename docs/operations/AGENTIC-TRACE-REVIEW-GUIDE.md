# Agentic Decision Trace Review Guide

Scope: Visibility Marketing agent action proposals and execution traces.

Primary endpoints:
- `GET /api/admin/agentic/quality?windowDays=30`
- `GET /api/admin/agentic/subjects/{subjectId}/decision-trace?tenantId=default`
- `GET /api/agentic/actions/{actionId}/audit`

## Required Trace Fields

The quality endpoint reports `traceCompleteness` over these fields:

| Field | Source | Purpose |
|---|---|---|
| metadata | `ai_metadata_json` | Confirms AI/fallback metadata exists. |
| promptVersion | `ai_metadata_json.promptVersion` | Identifies the prompt or capability version. |
| responseSchemaVersion | `ai_metadata_json.responseSchemaVersion` | Confirms schema compatibility. |
| providerModelOrFallback | `provider` + `model`, or explicit `fallback` | Distinguishes model advice from deterministic fallback. |
| routeReason | `ai_metadata_json.explanation` or action `reason` | Explains why the action was proposed. |
| fallbackReason | `error`, `rawSummary.error`, or explanation when fallback is true | Explains degraded paths. |
| policyResult | `policy_result_json.allowed` | Shows why the proposal was allowed or blocked. |
| signalSummary | `evidence_json.signalCount` and `signalTypes` | Shows the signal basis. |
| subjectContext | `evidence_json.subjectContext` | Shows relevant recent history and channel context. |
| outcomeSummary | `subjectContext.recentOutcomeTypes` | Shows whether prior actions succeeded or fatigued. |

## Review Procedure

1. Start with `GET /api/admin/agentic/quality?windowDays=30`.
2. Inspect `traceCompleteness.completeRate` and the `missing` counts.
3. Open recent `recentQualityRisks` rows first.
4. For each sampled row, call the subject decision trace endpoint.
5. Confirm the action has a coherent chain: signals -> subject context -> AI/fallback reason -> policy result -> execution/outcome.
6. If any field is missing, classify it as instrumentation debt, fallback debt, or policy/audit debt.

## Reviewer Checklist

- The signal types and confidence explain why the action was considered.
- The subject context includes recent action history, repeated-category warnings, channel availability, and lifecycle stage where available.
- The policy result shows allowed/blocked reasons and required approval state.
- AI metadata identifies provider/model/prompt/schema for model-assisted proposals.
- Fallback rows have an explicit fallback flag and reason.
- High-confidence proposals with `no_outcome_observed` have enough data for diagnosis.
- Repeated same-category proposals are justified by context or restricted.
- Raw PII is not copied into trace notes.

## Escalation Rules

| Condition | Action |
|---|---|
| `traceCompleteness.completeRate < 0.95` | Create instrumentation remediation ticket. |
| Missing provider/model on non-fallback rows | Restrict prompt/model rollout until fixed. |
| Missing policy result | Block autonomous execution for affected action path. |
| Missing signal or subject context | Keep proposals in manual review. |
| Fallback reason absent | Fix ai-engine client metadata before deployment. |
