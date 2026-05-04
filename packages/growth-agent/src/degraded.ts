import type {
  CapabilityName,
  GrowthNextActionRequest,
  GrowthNextActionResponse,
  GrowthSignalSummarizeRequest,
  GrowthSignalSummarizeResponse,
  JourneyCriticResponse,
  MessageBriefRequest,
  MessageBriefResponse,
  OutcomeDiagnoseResponse,
} from "./types";

export function degradedResponseFor(
  capability: CapabilityName,
  input: unknown,
  reason: string,
): unknown {
  switch (capability) {
    case "growth-next-action":
      return fallbackGrowthNextAction(input as GrowthNextActionRequest, reason);
    case "growth-signal-summarize":
      return fallbackGrowthSignalSummarize(input as GrowthSignalSummarizeRequest, reason);
    case "journey-critic":
      return fallbackJourneyCritic(reason);
    case "message-brief":
      return fallbackMessageBrief(input as MessageBriefRequest, reason);
    case "outcome-diagnose":
      return fallbackOutcomeDiagnose(reason);
    default:
      return { reason: "unsupported" };
  }
}

function fallbackGrowthNextAction(
  input: GrowthNextActionRequest,
  reason: string,
): GrowthNextActionResponse {
  return {
    action: {
      type: "wait",
      params: {
        cooldownHours: 24,
        subjectId: input.subjectId,
      },
      reason,
    },
    riskLevel: "low",
    confidence: 0.2,
    explanation: "Deterministic fallback selected for safe continuity.",
    rawSummary: "Predictive route unavailable.",
  };
}

function fallbackGrowthSignalSummarize(
  input: GrowthSignalSummarizeRequest,
  reason: string,
): GrowthSignalSummarizeResponse {
  return {
    summary: "Deterministic summary fallback.",
    severity: "low",
    keyDrivers: input.signals.slice(0, 3).map((s) => s.name),
    urgencyWindow: reason,
  };
}

function fallbackJourneyCritic(reason: string): JourneyCriticResponse {
  return {
    critique: "Deterministic critique fallback.",
    risks: ["insufficient_signal_coverage"],
    suggestedAdjustments: [reason, "run_small_cohort_experiment"],
  };
}

function fallbackMessageBrief(input: MessageBriefRequest, reason: string): MessageBriefResponse {
  return {
    headline: input.objective,
    coreMessage: "Deterministic brief fallback.",
    tone: "clear",
    cta: "Learn more",
    guardrails: ["white_label_safe", reason],
  };
}

function fallbackOutcomeDiagnose(reason: string): OutcomeDiagnoseResponse {
  return {
    diagnosis: "Deterministic diagnosis fallback.",
    likelyCauses: [reason],
    recommendedNextExperiments: ["extend_observation_window"],
  };
}
