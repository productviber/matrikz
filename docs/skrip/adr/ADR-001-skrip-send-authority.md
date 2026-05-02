# ADR-001: Single Send Authority Per Channel

## Status

Accepted

## Context

Visibility-Marketing currently owns email execution directly. Introducing Skrip for additional channels creates a migration risk: both systems could send to the same contact on the same channel if routing is implicit or partially enabled.

## Decision

Visibility-Marketing will resolve a single execution authority per tenant, campaign, and channel before any message is queued. For each channel, the authority is either `visibility_marketing` or `skrip`, never both.

## Consequences

- Dual-send risk is reduced to routing or data bugs rather than architecture ambiguity.
- Rollback is simple because authority can be switched without rewriting campaign semantics.
- Email can remain local while push and messaging channels move independently.

## Rejected alternatives

- Best-effort runtime avoidance without an authority registry: rejected because it is not auditable.
- Splitting authority by contact at send time only: rejected because it complicates rollback and reporting.