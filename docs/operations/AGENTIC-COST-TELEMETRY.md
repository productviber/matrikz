# Agentic Cost Telemetry Guide

Scope: AI-assisted proposals created by Visibility Marketing and advised by growth-agent.

Primary source: `GET /api/admin/agentic/quality?windowDays=30`

## Reported Fields

| Field | Meaning |
|---|---|
| `tokenEstimateTotal` | Sum of `ai_metadata_json.tokenEstimate` across proposals with metadata. |
| `costEstimateTotal` | Sum of `ai_metadata_json.costEstimate` across proposals with metadata. |
| `avgTokensPerProposal` | Token estimate total divided by all proposals in the window. |
| `avgCostPerProposal` | Cost estimate total divided by all proposals in the window. |
| `costPerExecutedAction` | Executed cost estimate total divided by executed/outcome-observed actions. |
| `costPerPositiveOutcome` | Cost estimate total divided by conversion or engagement outcomes. |
| `missingCostEstimateCount` | Metadata rows where cost estimate is absent. |
| `executedMissingCostEstimateCount` | Executed/outcome-observed rows with absent cost estimate. |
| `aiMetadataByDimension` | Provider/model/prompt/schema/capability/fallback grouped cost and token totals. |

## Null Cost Semantics

Use these interpretations consistently in reviews and remediation tickets:

| Metadata state | Interpretation | Operator action |
|---|---|---|
| `costEstimate = 0` and provider/model present | Free, prepaid, or local-priced model path with explicit zero cost. | Treat as known zero cost. |
| `costEstimate = null`, provider/model present | Instrumentation gap for a real provider/model path. | Count as missing telemetry and create a cost instrumentation ticket. |
| `costEstimate = null`, `fallback = true` | Deterministic fallback path with no model spend. | Treat as zero model cost, but monitor fallback rate. |
| `costEstimate = null`, no provider/model, `fallback != true` | Ambiguous metadata. | Treat as incomplete trace and cost telemetry debt. |
| `tokenEstimate = null`, provider/model present | Token accounting gap. | Create telemetry ticket if repeated. |

## Review Procedure

1. Read `aiMetadataByDimension` before evaluating aggregate costs.
2. Separate fallback rows from model-assisted rows.
3. Compare cost per proposal, executed action, and positive outcome against the previous review period.
4. Investigate dimensions where cost rose while positive outcome rate fell.
5. Treat rising missing-cost counts as a release blocker for model/prompt changes.

## Threshold Guidance

| Metric | Watch | Block |
|---|---:|---:|
| Missing cost estimate rate | > 5% | > 10% |
| Executed missing cost estimate rate | > 2% | > 5% |
| Cost per positive outcome | Rising one review period | Rising two review periods |
| Cost by one provider/model dimension | > 2x prior period | > 3x prior period without uplift |
