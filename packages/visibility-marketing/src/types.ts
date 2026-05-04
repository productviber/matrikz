import type {
  ActionType,
  CapabilityEnvelope,
  CapabilityName,
} from "@matrikz/growth-agent-contracts";

export type GrowthCapability = CapabilityName;
export type GrowthAgentEnvelope<T> = CapabilityEnvelope<T>;
export type MarketerActionType = ActionType;

export interface MarketingEnv {
  ENVIRONMENT?: string;
  INTERNAL_SECRET?: string;
  GROWTH_AGENT_TIMEOUT_MS?: string;
  GROWTH_AGENT?: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}
