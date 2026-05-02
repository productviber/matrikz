# ADR-002: Canonical Identity and Normalized Event Envelope

## Status

Accepted

## Context

Current marketer workflows are heavily email-oriented. Multichannel execution through Skrip requires a shared identity strategy and a normalized outcome envelope so reporting and attribution remain coherent across push, WhatsApp, SMS, Telegram, and email.

## Decision

Every integrated message flow will carry explicit `tenantId`, `externalContactId`, optional `canonicalId`, and a normalized event envelope with `eventId`, `eventType`, `campaignId`, `stepId`, `channel`, `messageId`, `occurredAt`, `sourceSystem`, and `correlationId`.

## Consequences

- Contact lineage becomes auditable across systems.
- Analytics and reporting can aggregate outcomes consistently by channel.
- Identity reconciliation can be performed without overloading business logic.

## Rejected alternatives

- Treating email or phone as the canonical identity: rejected because it breaks across channel-specific states and consent models.
- Provider-native events only: rejected because it leaks provider differences into product reporting.