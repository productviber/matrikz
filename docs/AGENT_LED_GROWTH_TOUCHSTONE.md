# Agent-Led Growth Architecture Touchstone

Date: 2026-05-02

Touchstone: **scale product adoption with agent-led growth**.

Implementation scoping lives in [implementation-scopes/README.md](implementation-scopes/README.md). Use those todo lists to plan concrete build, modify, extract, and remove work across Visibility Marketing, Visibility Analytics, Skrip, ai-engine, and cross-product capabilities.

This document captures the architectural position behind Visibility Marketing, Visibility Analytics, and Skrip. It is not just a naming exercise. It is the operating philosophy we use when deciding where code belongs, where authority lives, and how agents should move through the system without creating a split brain.

The phrase we are protecting is simple:

```text
Scale product adoption with agent-led growth.
```

That means an agent must be able to observe product and lifecycle signals, decide the next growth action, execute that action through the right channel, and learn from the result. The architecture exists to make that loop durable, auditable, tenant-safe, channel-agnostic, and outcome-aware.

## The Four M Frame

The working language is the Four M frame:

```text
Manufacturing Intelligent Messages with AI
Manifesting Intelligent Conversations with AI
Maximising Intelligent Conversions with AI
Maintaining Intelligent Identity with AI
```

The first correction is important: these are **capability planes**, not four boxes in an org chart and not necessarily four deployable services.

Some services own a plane deeply. Other services touch that plane through projections. Identity is the clearest example: every part of the system reads and writes identity-adjacent facts, but not every part is authoritative for the same kind of identity.

## Capability Definitions

### Manufacturing Intelligent Messages With AI

Manufacturing is the production discipline: sometimes pure signals, sometimes vernacular.

A pure signal may be a tight push notification, a badge, a delivery event, a short prompt, or a deterministic template. Vernacular is language, register, timing, cultural fit, and user-specific context. Manufacturing does not merely write copy; it turns intent, identity projection, policy, budget, and channel constraints into a valid payload.

Primary home today: **Skrip**.

Skrip is already named and shaped around this idea. Its own vision is outcome-routed, multi-tenant LLM orchestration for messaging. Its core primitives include message manufacturing, model routing, budget control, prompt/version telemetry, delivery outcome joins, and channel dispatch.

Skrip should own:

- Signal and vernacular payload manufacture.
- Template-first and LLM-assisted generation.
- Per-tenant budget and model routing.
- Channel payload validity.
- Delivery provider integration.
- Send/outcome telemetry at the message and channel level.

Skrip should not own the question: "Which product user needs a growth intervention now?" That is not manufacturing. That is growth orchestration.

### Manifesting Intelligent Conversations With AI

Manifesting is the orchestration engine: making the right conversation happen across channels.

It decides the growth journey, the sequence, the timing, the eligibility, the fallback policy, and the next action. It turns product and lifecycle intelligence into a conversation plan.

Primary home today: **Visibility Marketing**.

Visibility Marketing owns sequences, campaign state, attribution, outbound prospect flows, affiliate/share loops, lifecycle events, and the emerging agentic access lane. It is where a growth agent should live because it has the right context: lifecycle, funnel, campaign, attribution, and user adoption state.

Visibility Marketing should own:

- Growth journeys and campaign orchestration.
- Sequence enrollment and suppression.
- Product adoption interventions.
- Attribution and uplift reporting.
- Agentic growth decisions and audit trail.
- The integration boundary to Skrip for channel execution.

Visibility Marketing should not manufacture every channel payload itself if Skrip can do it with stronger channel, language, telemetry, and budget guarantees.

### Maximising Intelligent Conversions With AI

Maximising is the domain-specific vehicle: the actual commercial or adoption outcome.

For Visibility, that may be signup, activation, trial conversion, subscription upgrade, report generation, share conversion, or affiliate conversion. For a bus operator, it is booking made, journey recovered, route purchase, loyalty milestone, or retained passenger. For a clinic, it would be appointment booked or patient retained.

Primary home today: **domain apps plus Visibility Analytics and Visibility Marketing**.

The domain app is authoritative for conversion truth. Analytics turns product behavior into measurable signals. Marketing acts on those signals and records the growth action. But marketing must not invent conversion truth. A booking system knows a booking happened. A payments system knows a payment cleared. A product analytics system knows whether adoption occurred.

Maximising should own:

- Domain event truth.
- Conversion semantics.
- Outcome windows and attribution inputs.
- Business-specific constraints and success metrics.

Visibility Marketing can optimize toward conversions, but conversion authority remains with the product or vertical system that observes the real outcome.

### Maintaining Intelligent Identity With AI

Maintaining is not just a layer in the middle. It is a substrate.

Identity is the persistent memory of the loop: who the person is, how they can be reached, what they consented to, what they did, what they ignored, what they converted on, and what should happen next.

The second correction is important: identity is **federated authority**, not one global table that everyone mutates freely.

```text
Maintaining identity substrate

  product identity      channel identity      growth identity      behavior signals
  users, sites, plans   aliases, consent      lifecycle, journey   engagement, health
  domain authority      Skrip authority       Marketing authority  Analytics authority
```

Skrip owns channel identity. Visibility Analytics owns product and behavior signal identity. Visibility Marketing owns growth relationship identity. Domain apps own business identity and conversion truth.

The rule is not "only one system has identity." The rule is: **each identity fact has one clear authority, and every other system receives a projection.**

## Architectural Schematic

The runtime loop is this:

```text
                    Maintaining identity substrate
       product identity | channel identity | growth state | behavior signals
                         ^          ^          ^          ^
                         |          |          |          |
Domain app outcome -> Visibility Analytics -> Visibility Marketing -> Skrip
      conversion          product signal        growth agent       manufacture/send
          ^                    |                    |                    |
          |                    v                    v                    v
          +-------------- outcomes and engagement feed back -------------+
```

Read as a growth loop:

```text
know who -> decide why now -> manufacture the right message -> deliver -> observe outcome -> know more
```

But "know who" is not a single step. It is the maintained substrate that every step reads from and writes back into.

## Current Code Evidence

### Skrip Is More Than A Dumb Delivery Adapter

The separate Skrip codebase contains real channel identity and manufacturing primitives:

- `contacts`
- `channel_subscriptions`
- `identity_graph`
- `channel_preferences`
- `outbound_messages`
- `push_events`
- `generation_events`
- `outcome_events`
- message manufacturer and manufacturer v2
- routing, budget, telemetry, workflow, and channel send pipelines

This means Skrip is not merely "send bytes to provider." It is an intelligent message manufacturing and channel-identity engine.

The nuance is authority. Skrip's identity is channel and delivery identity. It should know how to reach a canonical person through push, WhatsApp, Telegram, SMS, and future channels. It should not become the CRM, CDP, product analytics system, or vertical conversion ledger.

### Visibility Marketing Owns Growth Orchestration

Visibility Marketing owns the integration side of Skrip and the growth lifecycle:

- `marketing_contacts` for growth/contact lifecycle.
- `email_sequences`, `email_steps`, and `email_sends` for local email journeys.
- `contact_channel_identities` as a Skrip-facing projection.
- `channel_execution_outbox` as the reliable handoff to Skrip.
- `channel_message_lineage` for normalized outcome attribution.
- event handlers for signup, conversion, trial, plan, share, affiliate, outbound, and audit funnel events.
- agentic access lane and audit metadata.

This is the right home for the growth agent because the growth agent needs lifecycle, campaign, attribution, and product adoption context.

### Visibility Analytics Owns Product And Adoption Signals

Visibility Analytics owns shared user/site data and product intelligence:

- `users`
- `sites`
- `gsc_data`
- `bing_data`
- `cloudflare_data`
- product health and report data APIs

It emits events into Visibility Marketing. It should remain a signal and measurement surface, not a campaign execution engine.

## Authority Partition

Use this table when deciding where new code belongs.

| Question | Authority |
|---|---|
| Who is this product user, what plan are they on, and what product activity occurred? | Visibility Analytics or the domain app |
| Has this person converted, booked, paid, renewed, or churned? | Domain app or payment/product system |
| What lifecycle stage, campaign, sequence, or growth journey applies? | Visibility Marketing |
| Should an agent enroll, pause, start, retry, or target a growth action? | Visibility Marketing |
| Which channels can reach this person, and what is their channel preference? | Skrip, projected into Marketing when needed |
| How should the message be manufactured for this channel, language, and budget? | Skrip |
| Which provider sends the message and how is the outcome normalized? | Skrip |
| Which marketing campaign or step gets attribution credit? | Visibility Marketing, using Skrip outcomes and analytics conversion events |

## Agentic Layer Position

The agentic layer belongs in both systems, but not as the same layer.

### Visibility Marketing: Agentic Growth Controller

Visibility Marketing should expose agentic growth operations:

- read growth signals
- inspect attribution
- enroll a contact or segment
- trigger a growth journey
- pause or start campaigns
- request best next action
- audit the action taken

This is the agent that asks: "What should we do to scale product adoption?"

### Skrip: Agent-Callable Manufacturing And Channel Primitives

Skrip should expose agent-callable primitives:

- lookup canonical identity
- list reachable channels
- recommend channel by recent engagement and consent
- manufacture signal or vernacular payload
- send or schedule a channel message
- read delivery and engagement outcome
- explain model/channel routing decision

This is the agent-capable engine that answers: "How do we safely manufacture and deliver this message?"

### Visibility Analytics: Signal Source

Visibility Analytics should expose or emit adoption signals:

- trial nearing expiry
- product activation stalled
- insight generated
- site health improved or degraded
- share viewed or converted
- plan upgraded or downgraded
- user converted or churned

This is not the growth agent. It is the agent's measurement and signal surface.

## Domain-Specific Code In Skrip

There is domain-specific bus-booking code in Skrip today. That was useful for proving the platform, but it should not remain hard-coded in Skrip core.

Examples of domain-specific concerns currently visible in Skrip:

- `src/domain/bus-booking/config.ts`
- bus-booking triggers such as route availability, re-engagement, loyalty milestone, flash sale, and journey update
- Indian intercity bus copy guidance and fallback templates
- hard-coded use of `busDomainConfig` in channel send and workflow paths

This code is valuable, but its home should change.

### Why It Must Move

Skrip's defensible platform role is manufacturing, channel identity, routing, budget, telemetry, and delivery. If bus-specific triggers and copy remain inside core runtime paths, every new vertical will pressure Skrip into becoming a pile of domain apps.

That would violate Skrip's own posture: it is not a CRM, not a CDP, and not a vertical application. It integrates with vertical applications.

### New Home For Domain Code

The domain-specific code should move into **domain packs**.

Recommended shape:

```text
skrip/
  packages/
    domain-contracts/
      TriggerDomainConfig interface
      trigger schema interfaces
      fallback/template contracts
    domain-bus-booking/
      config.ts
      triggers.ts
      fallback templates
      golden tests
    domain-clinic/
      config.ts
      triggers.ts
    domain-hotel/
      config.ts
      triggers.ts
```

Skrip core should depend on the contract, not on `bus-booking` directly.

The runtime should resolve the domain pack through tenant policy or a tenant manifest:

```text
tenant_id -> domain_key -> domain pack -> TriggerDomainConfig -> manufacturer
```

For local development, a default demo domain pack is acceptable. In production, the route should not hard-code bus-booking as the only domain.

### Migration Plan

1. Define a stable `TriggerDomainConfig` contract package.
2. Move `src/domain/bus-booking` into a domain-pack package.
3. Replace hard-coded `busDomainConfig` imports with a `resolveDomainConfig(tenantId, triggerType)` boundary.
4. Add tenant policy or tenant manifest field: `domainKey`.
5. Add contract tests for every domain pack: schema, fallback payload shape, language behavior, trigger metadata, and prompt safety.
6. Keep one demo bus tenant wired to prove compatibility.
7. Refuse unknown domain keys with a typed error rather than falling back to bus assumptions.

This preserves the useful vertical intelligence while keeping Skrip core clean.

## Boundary Rules

Use these as decision rules in design reviews.

1. If code decides **who should receive a growth action**, it belongs in Visibility Marketing.
2. If code decides **what product event actually happened**, it belongs in the domain app or Visibility Analytics.
3. If code decides **how to manufacture a payload under channel, language, budget, and model constraints**, it belongs in Skrip.
4. If code stores **channel identifiers, subscriptions, reachability, channel preference, or delivery outcomes**, Skrip is authoritative.
5. If code stores **campaign membership, sequence enrollment, attribution, or growth audit**, Visibility Marketing is authoritative.
6. If multiple systems need the same fact, create a projection or event contract. Do not create shared mutable ownership.
7. If a system needs another system's authority, call it through a contract. Do not reach into its private tables.
8. If a domain-specific assumption appears in a platform route, extract it into a domain pack.

## Anti-Patterns

- Turning Skrip into a CRM or CDP.
- Letting Visibility Marketing forge or override Skrip canonical identity.
- Letting Visibility Analytics send campaigns directly.
- Hard-coding bus-booking assumptions in generic Skrip routes.
- Treating identity as one table instead of federated authority.
- Treating an agentic token as an admin token.
- Optimizing for CTR while ignoring unsubscribe, churn, or conversion quality.
- Measuring generations instead of outcomes.

## Target Agent-Led Growth Loop

The target loop should look like this:

```text
1. Domain app or Analytics emits adoption signal.
   Example: trial_expiring, report_ready, booking_abandoned, route_reopened.

2. Visibility Marketing evaluates the growth opportunity.
   It checks lifecycle state, campaign policy, suppression, attribution, and agent permissions.

3. Growth agent chooses the next action.
   It may enroll, pause, start, target, or ask Skrip for channel intelligence.

4. Visibility Marketing stages the action.
   It writes growth audit and outbox/sequence state.

5. Skrip manufactures and delivers.
   It resolves channel identity, chooses template or model, respects budget, sends, and records telemetry.

6. Outcomes return.
   Delivery, tap, reply, unsubscribe, conversion, and failure events are normalized.

7. Maintaining substrate improves.
   Channel preference, growth attribution, product state, and conversion truth are updated by their authorities.

8. The next agent decision is better.
```

## What This Means For The Next Build

Visibility Marketing should get a real `/api/agentic` namespace for the growth controller:

- `GET /api/agentic/growth-signals`
- `POST /api/agentic/enroll`
- `POST /api/agentic/send`
- `GET /api/agentic/attribution/summary`
- `GET /api/agentic/audit`

Skrip should get agent-callable primitive endpoints only where they support manufacturing and channel intelligence:

- identity lookup
- channel recommendation
- message manufacture preview
- send/schedule
- outcome lookup
- routing explanation

Visibility Analytics should strengthen signal contracts and event schemas, not become the orchestrator.

Domain apps should emit conversion truth and own vertical semantics.

Domain packs should remove vertical code from Skrip core while letting Skrip remain excellent at manufacturing.

## Final Position

The right architecture is not pure separation. It is disciplined federation.

Skrip is the intelligent manufacturing and channel-identity engine.

Visibility Marketing is the agentic growth and conversation orchestration engine.

Visibility Analytics is the product signal and adoption intelligence engine.

Domain apps are the conversion truth engines.

Maintaining Identity is the substrate across all of them, governed by explicit authority and projections.

This is how we scale product adoption with agent-led growth without collapsing everything into one platform blob and without splitting truth across systems that cannot explain themselves.

## Responsibility Addendum (2026-05-04)

Cross-repo review of Matrikz growth-agent, Visibility Marketing, and Skrip confirms the intended architecture is directionally correct:

- Matrikz growth-agent is the structured decision API.
- Visibility Marketing is the growth orchestration, policy, and attribution layer.
- Skrip is the manufacturing, channel identity, and delivery layer.

The current gap is no longer basic authority confusion. The remaining work is integration closure:

1. certify one canonical live-contract staging path across Marketing -> Skrip -> normalized outcomes,
2. tighten channel-support contracts so unsupported channels are rejected or downgraded explicitly,
3. simplify execution-lane semantics where one action can currently flow through more than one technical path,
4. strengthen semantic evaluation and rollout governance on the advisory plane.

Use this rule in all future design reviews:

- decide why now -> Visibility Marketing,
- recommend the structured next move -> Matrikz growth-agent,
- manufacture and deliver safely -> Skrip,
- record product conversion truth -> domain apps or Analytics.