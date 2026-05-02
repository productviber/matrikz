# Agent-Led Growth Implementation Scopes

Date: 2026-05-02

North star: **scale product adoption with agent-led growth**.

These documents convert the architecture position in [../AGENT_LED_GROWTH_TOUCHSTONE.md](../AGENT_LED_GROWTH_TOUCHSTONE.md) into scoped implementation todo lists. They are intentionally split by product boundary so work can be estimated, sequenced, and assigned without blurring authority between Visibility Marketing, Visibility Analytics, Skrip, ai-engine, and shared product capabilities.

## Status Model

- `[ ]` not started
- `[-]` in progress
- `[x]` complete
- `[?]` needs decision or discovery

## Action Types

- **Build**: new capability or surface.
- **Modify**: change an existing capability without moving ownership.
- **Extract**: move domain-specific or shared logic to a better home.
- **Remove**: delete, retire, or deprecate capability that creates confusion, duplicated authority, or unsafe behavior.

## Scope Files

| Scope | File | Primary Question |
|---|---|---|
| Visibility Marketing | [VISIBILITY_MARKETING_TODO.md](VISIBILITY_MARKETING_TODO.md) | What should the growth agent decide, execute, audit, and learn from? |
| Visibility Analytics | [VISIBILITY_ANALYTICS_TODO.md](VISIBILITY_ANALYTICS_TODO.md) | Which product and adoption signals should become authoritative growth inputs? |
| Skrip | [SKRIP_TODO.md](SKRIP_TODO.md) | How should messages and channel conversations be manufactured and delivered? |
| ai-engine | [AI_ENGINE_TODO.md](AI_ENGINE_TODO.md) | Which model-powered reasoning capabilities should be reused or added? |
| Cross-product capabilities | [CROSS_PRODUCT_CAPABILITY_TODO.md](CROSS_PRODUCT_CAPABILITY_TODO.md) | Which shared contracts, domain packs, identity rules, and operating surfaces cut across repos? |

## Determinism Target

The implementation rule is: **AI proposes, deterministic systems dispose.**

| System | Deterministic Target | Non-deterministic Target | Notes |
|---|---:|---:|---|
| Visibility Marketing | 80-90% | 10-20% | Growth control, eligibility, execution, attribution, audit. |
| Visibility Analytics | 85-95% | 5-15% | Product/adoption signal truth, scoring, summaries. |
| Skrip | 70-85% | 15-30% | Deterministic shell around message manufacture and channel delivery. |
| ai-engine | 50-70% | 30-50% | Structured inference platform; never action executor. |
| Cross-product substrate | 90-100% | 0-10% | Contracts, policy, identity authority, migrations, audits. |

## Recommended Sequencing

1. Build deterministic growth signals and the agent action ledger in Visibility Marketing.
2. Add growth proposal capabilities to ai-engine with strict structured outputs.
3. Add `/api/agentic/*` proposal and execution routes in Visibility Marketing.
4. Extract Skrip domain packs and expose agent-callable manufacture/send primitives.
5. Expand Visibility Analytics event contracts for activation, retention, product health, and conversion truth.
6. Close attribution loops across marketing actions, Skrip outcomes, analytics events, and domain conversion events.
7. Add cross-repo contract tests, operational dashboards, rollback switches, and governance reviews.

## Completion Criteria

The scope is ready for implementation planning when each linked file has:

- clear owner and authority boundary,
- phased todo list,
- deterministic vs non-deterministic split,
- build/modify/extract/remove classification,
- acceptance checks,
- test/validation expectations,
- explicit dependencies on other systems.
