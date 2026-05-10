import type {
  GrowthNextActionRequest,
  GrowthNextActionResponse,
  MessageBriefRequest,
  MessageBriefResponse,
  OutcomeDiagnoseRequest,
  OutcomeDiagnoseResponse,
} from "../../src/types";
import type {
  GrowthNextActionExpectation,
  MessageBriefExpectation,
  OutcomeDiagnoseExpectation,
} from "../../src/evals/semanticEval";
import type { RuntimeConfig } from "../../src/types";

export const semanticEvalConfig: RuntimeConfig = {
  appVersion: "0.1.0",
  requestSchemaVersion: "1.0.0",
  responseSchemaVersion: "1.0.0",
  model: "semantic-eval-fixture-model",
  timeoutMs: 250,
  maxRetries: 0,
  outputRepairAttempts: 1,
  budgetPerTenantPerMinute: 100,
  rateLimitPerTenantCapabilityPerMinute: 100,
  secretRotationWindowHours: 24,
  proactiveScanEnabled: false,
  proactiveScanCooldownHours: 24,
  priorTtlDays: 30,
  calibrationRecalcAfterN: 10,
  outcomeRetentionDays: 90,
  auditSampleRate: 0.1,
  proactiveScanBatchSize: 50,
  maxPendingPerTenant: 5,
  featureFlags: {
    "growth-next-action": true,
    "growth-signal-summarize": true,
    "journey-critic": true,
    "message-brief": true,
    "outcome-diagnose": true,
  },
};

export type SemanticEvalFixture =
  | {
      id: string;
      capability: "growth-next-action";
      input: GrowthNextActionRequest;
      modelResponse: GrowthNextActionResponse;
      expected: GrowthNextActionExpectation;
    }
  | {
      id: string;
      capability: "message-brief";
      input: MessageBriefRequest;
      modelResponse: MessageBriefResponse;
      expected: MessageBriefExpectation;
    }
  | {
      id: string;
      capability: "outcome-diagnose";
      input: OutcomeDiagnoseRequest;
      modelResponse: OutcomeDiagnoseResponse;
      expected: OutcomeDiagnoseExpectation;
    };

export const semanticEvalFixtures: SemanticEvalFixture[] = [
  {
    id: "gna-high-intent-activate",
    capability: "growth-next-action",
    input: {
      tenantId: "tenant-eval",
      subjectId: "contact-high-intent",
      outputLocale: "en",
      context: {
        subjectContext: {
          lifecycleStage: "qualified",
          recentOutcomes: [],
          lastActionType: null,
          activeSignalCount: 3,
        },
        policyHints: {
          effectiveChannels: ["email"],
          hintBlocked: false,
          hintBlockedReasons: [],
        },
      },
      signals: [
        { kind: "number", name: "intent", value: 0.91, weight: 0.9 },
        { kind: "boolean", name: "engagement", value: true, weight: 0.8 },
        { kind: "string", name: "lifecycle_stage", value: "qualified", weight: 0.7 },
      ],
    },
    modelResponse: {
      action: {
        type: "activate",
        params: { subjectId: "contact-high-intent" },
        reason: "high intent and active engagement indicate readiness",
      },
      riskLevel: "low",
      confidence: 0.86,
      explanation: "The contact has high intent and engagement, so an activation prompt is appropriate.",
      rawSummary: "High intent, active engagement, qualified lifecycle stage.",
    },
    expected: {
      expectedActionTypes: ["activate", "convert"],
      maxRiskLevel: "medium",
      minConfidence: 0.75,
      expectedSubjectId: "contact-high-intent",
      requiredTerms: ["intent", "engagement"],
    },
  },
  {
    id: "gna-suppressed-contact-wait",
    capability: "growth-next-action",
    input: {
      tenantId: "tenant-eval",
      subjectId: "contact-suppressed",
      outputLocale: "en",
      context: {
        subjectContext: {
          lifecycleStage: "prospect",
          recentOutcomes: [],
          lastActionType: null,
          activeSignalCount: 2,
        },
        policyHints: {
          effectiveChannels: [],
          hintBlocked: true,
          hintBlockedReasons: ["activate", "convert", "recover"],
        },
      },
      signals: [
        { kind: "number", name: "intent", value: 0.82, weight: 0.8 },
        { kind: "boolean", name: "engagement", value: true, weight: 0.5 },
      ],
    },
    modelResponse: {
      action: {
        type: "wait",
        params: { subjectId: "contact-suppressed", cooldownHours: 24 },
        reason: "policy block prevents outreach despite positive intent",
      },
      riskLevel: "low",
      confidence: 0.72,
      explanation: "The contact has intent signals, but policy blocks outreach, so waiting is safest.",
      rawSummary: "Suppression/policy block is active; no eligible channel remains.",
    },
    expected: {
      expectedActionTypes: ["wait", "pause", "escalate"],
      forbiddenActionTypes: ["activate", "convert", "recover"],
      maxRiskLevel: "low",
      maxConfidence: 0.8,
      expectedSubjectId: "contact-suppressed",
      requiredTerms: ["policy", "block"],
    },
  },
  {
    id: "gna-fatigue-no-response-pause",
    capability: "growth-next-action",
    input: {
      tenantId: "tenant-eval",
      subjectId: "contact-fatigued",
      outputLocale: "en",
      context: {
        subjectContext: {
          lifecycleStage: "prospect",
          recentOutcomes: [
            { actionType: "activate", outcomeType: "no_outcome_observed", daysSinceExecution: 3, confidence: 0.33 },
            { actionType: "nurture", outcomeType: "no_response", daysSinceExecution: 8, confidence: 0.31 },
          ],
          lastActionType: "activate",
          activeSignalCount: 4,
        },
        policyHints: {
          effectiveChannels: ["email", "sms"],
          hintBlocked: false,
          hintBlockedReasons: [],
        },
      },
      signals: [
        { kind: "number", name: "churn_risk", value: 0.78, weight: 0.8 },
        { kind: "boolean", name: "engagement", value: false, weight: 0.7 },
      ],
    },
    modelResponse: {
      action: {
        type: "pause",
        params: { subjectId: "contact-fatigued", cooldownHours: 72 },
        reason: "fatigue and repeated no-response signals require cooldown",
      },
      riskLevel: "medium",
      confidence: 0.81,
      explanation: "Repeated no-response and fatigue signals make more outreach risky.",
      rawSummary: "Churn risk is elevated while engagement is absent after repeated no-response.",
    },
    expected: {
      expectedActionTypes: ["pause"],
      forbiddenActionTypes: ["activate", "convert"],
      maxRiskLevel: "medium",
      minConfidence: 0.7,
      expectedSubjectId: "contact-fatigued",
      requiredTerms: ["fatigue", "no-response"],
    },
  },
  {
    id: "message-brief-inactive-enterprise",
    capability: "message-brief",
    input: {
      tenantId: "tenant-eval",
      outputLocale: "en",
      objective: "Re-engage inactive enterprise users without mentioning pricing",
      audience: "enterprise admins inactive for 21 days",
      channelHints: ["email", "sms"],
      constraints: ["do not mention pricing", "avoid pressure language", "keep CTA mobile friendly"],
    },
    modelResponse: {
      headline: "A quick way back to your workspace",
      coreMessage: "Your team can return to recent work in a few minutes. We kept the next step simple for inactive admins.",
      tone: "helpful and calm",
      cta: "Resume your workspace",
      guardrails: ["pricing not mentioned", "no pressure language"],
    },
    expected: {
      maxHeadlineChars: 80,
      maxCtaChars: 60,
      requiredTerms: ["return", "inactive"],
      forbiddenTerms: ["pricing", "$", "discount"],
      requiredGuardrailTerms: ["pricing"],
    },
  },
  {
    id: "outcome-diagnose-usage-drop",
    capability: "outcome-diagnose",
    input: {
      tenantId: "tenant-eval",
      outputLocale: "en",
      expected: {
        monthlyRecurringRevenue: 56000,
        churnRate: 0.03,
        productUsage: { dailyActiveUsers: 820, automationAdoption: 0.42 },
      },
      observed: {
        monthlyRecurringRevenue: 51000,
        churnRate: 0.065,
        productUsage: { dailyActiveUsers: 640, automationAdoption: 0.18 },
        recentSupportVolume: 14,
      },
    },
    modelResponse: {
      diagnosis: "Usage dropped while support volume increased, weakening expansion readiness.",
      likelyCauses: [
        "automation adoption fell below expected usage",
        "support volume likely introduced friction before renewal",
      ],
      recommendedNextExperiments: [
        "test onboarding recovery for low automation users",
        "route support-heavy accounts into a human-assisted retention sequence",
      ],
    },
    expected: {
      requiredCauseTerms: ["usage", "support"],
      requiredExperimentTerms: ["onboarding", "retention"],
      minLikelyCauses: 2,
      minRecommendedExperiments: 2,
      forbiddenTerms: ["guaranteed", "certain"],
    },
  },
];