export const CANONICAL_GROWTH_CONTRACT_PACKAGE = '@matrikz/growth-agent-contracts';

export const OUTCOME_DELTA_MAP = {
    recommended: 0.0,
    accepted: 0.3,
    dismissed: -0.2,
    overridden: -0.3,
    sent: 0.1,
    delivered: 0.1,
    opened: 0.5,
    clicked: 0.7,
    replied: 0.8,
    converted: 1.0,
    no_response: 0.0,
    no_action_recorded: 0.0,
    unsubscribed: -0.5,
    bounced: -0.3,
    dlq_dropped: -1.0,
} as const;

export type OutcomeMetric = keyof typeof OUTCOME_DELTA_MAP;