# Agentic Growth Quarterly Review Template

Owner: Visibility Marketing / Growth Operations
Cadence: Quarterly, plus ad-hoc review after model, prompt, policy, or deployment changes
Source endpoints: `GET /api/admin/agentic/quality`, `GET /api/admin/agentic/outcomes/export`, `GET /api/admin/governance/ingress-slo`, `GET /api/admin/governance/execution-slo`, `GET /internal/experiments/holdout-report`

## Review Header

| Field | Value |
|---|---|
| Review period | |
| Review date | |
| Environment | staging / production |
| Facilitator | |
| Product owner | |
| Marketing owner | |
| Engineering owner | |
| Data owner | |
| Governance/legal owner | |
| Deployment versions reviewed | |
| Prompt/schema versions reviewed | |

## Gate Summary

| Gate | Target | Actual | Status | Notes |
|---|---:|---:|---|---|
| Semantic eval pass rate | 100% | | pass / fail | |
| Schema validity | >= 99% | | pass / fail | |
| Fallback rate | <= 15% | | pass / watch / block | |
| Metadata completeness | >= 95% | | pass / watch / block | |
| Trace completeness | >= 95% | | pass / watch / block | |
| High-confidence no-outcome proxy | <= 20% | | pass / watch / block | |
| Repeated same-category intervention rate | decreasing | | pass / watch / block | |
| Cost per positive outcome | decreasing | | pass / watch / block | |
| Governance violation rate in observe | <= 2% | | pass / watch / block | |
| Holdout uplift sample sufficient | yes where claimed | | pass / watch / block | |

## Baseline Capture

Capture these values at the start of every review period and preserve them with the review notes.

```powershell
$base = $env:MARKETER_BASE_URL
$token = $env:MARKETER_ADMIN_TOKEN

Invoke-RestMethod -Method GET -Uri "$base/api/admin/agentic/quality?windowDays=30" -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 12
Invoke-RestMethod -Method GET -Uri "$base/api/admin/governance/ingress-slo?hours=720" -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method GET -Uri "$base/api/admin/governance/execution-slo?hours=720" -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 8
```

For holdout reporting, call the growth-agent internal endpoint from an authorized internal context:

```powershell
Invoke-RestMethod -Method GET `
  -Uri "$env:GROWTH_AGENT_BASE_URL/internal/experiments/holdout-report?windowDays=30&minArmSample=50" `
  -Headers @{ "x-internal-secret" = $env:INTERNAL_SECRET; "x-tenant-id" = "default" } | ConvertTo-Json -Depth 12
```

## Quality Review

| Metric | Current | Previous | Delta | Action |
|---|---:|---:|---:|---|
| Total proposals | | | | |
| Acceptance rate | | | | |
| Policy block rate | | | | |
| Fallback rate | | | | |
| Metadata completeness rate | | | | |
| Trace completeness rate | | | | |
| No-outcome rate | | | | |
| High-confidence no-outcome rate | | | | |
| False-negative proxy rate | | | | |
| Repeated same-category intervention rate | | | | |
| Repeated no-outcome category rate | | | | |

## Cost Review

| Metric | Current | Previous | Delta | Action |
|---|---:|---:|---:|---|
| Token estimate total | | | | |
| Cost estimate total | | | | |
| Average cost per proposal | | | | |
| Cost per executed action | | | | |
| Cost per positive outcome | | | | |
| Missing cost estimate count | | | | |
| Executed missing cost estimate count | | | | |

Use `aiMetadataByDimension` to isolate provider/model/prompt/schema/capability rows before making cost decisions.

## Holdout And Uplift Review

| Experiment | Action type | Treatment n | Control n | Positive outcome uplift | Conversion uplift | CI includes 0? | Decision |
|---|---|---:|---:|---:|---:|---|---|
| | | | | | | | continue / pause / promote |

Do not claim causal lift unless treatment and control arms both meet the configured minimum sample size and the confidence interval supports the claim.

## Sampled Decision Trace Review

Review at least 10 recent quality-risk rows and 10 random successful rows.

| Action ID | Subject | Proposed action | Risk | Confidence | Trace complete? | Outcome | Reviewer decision | Notes |
|---|---|---|---|---:|---|---|---|---|
| | | | | | | | approve / restrict / investigate | |

## Remediation Ticket Template

Create a ticket for every blocker threshold breach.

```markdown
Title: Agentic growth remediation: <metric> outside threshold

Environment:
Metric:
Observed value:
Threshold:
Window:
Evidence links or payload excerpts:
Suspected cause:
Blast radius:
Immediate mitigation:
Owner:
Due date:
Verification command:
Rollback or restriction plan:
```

## Review Outcome

| Decision | Criteria |
|---|---|
| Continue observe mode | Metrics within target or deviations have owners and low risk. |
| Restrict autonomy | No-outcome, repeated-category, fallback, trace, or governance metrics exceed watch thresholds. |
| Pause high-risk action type | High-confidence no-outcome, complaints, unsubscribe, or governance violations exceed blocker thresholds. |
| Promote rollout | Eval, quality, trace, cost, governance, smoke, and holdout gates pass. |
