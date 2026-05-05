import type {
  GrowthNextActionRequest,
  GrowthSignalSummarizeRequest,
  JourneyCriticRequest,
  MessageBriefRequest,
  OutcomeDiagnoseRequest,
} from "@matrikz/growth-agent-contracts";

export const detailedGrowthNextActionPayload: GrowthNextActionRequest = {
  tenantId: "tenant-1",
  subjectId: "customer-123",
  outputLocale: "en",
  context: {
    accountTier: "enterprise",
    recentCampaign: "Q2 upsell",
    geo: "US",
    productLine: "subscriptions",
    lastTouch: { channel: "email", timestamp: "2026-05-01T13:45:00Z" },
  },
  signals: [
    { kind: "number", name: "intent", value: 0.92, weight: 0.8 },
    { kind: "boolean", name: "engagement", value: true, weight: 0.6 },
    { kind: "string", name: "lifecycle_stage", value: "expansion", weight: 0.7 },
    { kind: "number", name: "revenue", value: 12400.5, weight: 0.55 },
    { kind: "number", name: "churn_risk", value: 0.2, weight: 0.3 },
  ],
};

export const detailedGrowthSignalSummarizePayload: GrowthSignalSummarizeRequest = {
  tenantId: "tenant-1",
  outputLocale: "en",
  context: {
    salesStage: "proposal",
    customerHealth: "good",
    recentInteractions: 12,
  },
  signals: [
    { kind: "number", name: "intent", value: 0.95, weight: 0.9 },
    { kind: "boolean", name: "engagement", value: false, weight: 0.4 },
    { kind: "string", name: "lifecycle_stage", value: "retention", weight: 0.55 },
  ],
};

export const detailedJourneyCriticPayload: JourneyCriticRequest = {
  tenantId: "tenant-1",
  outputLocale: "en",
  journeyState: {
    currentStage: "onboarding",
    healthScore: 72,
    timeInStageDays: 18,
    productUsage: {
      weeklyLogins: 3,
      majorFeatureAdoption: false,
    },
    customerProfile: {
      segment: "mid-market",
      primaryGoal: "reduce churn",
    },
  },
  priorActions: [
    {
      actionType: "activate",
      channel: "email",
      deliveredAt: "2026-04-25T15:00:00Z",
      result: "opened",
    },
    {
      actionType: "convert",
      offerCode: "SPRING24",
      estimatedValue: 4500,
      status: "pending",
    },
  ],
  outcomes: [
    {
      metric: "renewal_probability",
      value: 0.68,
      threshold: 0.75,
      trend: "flat",
    },
    {
      metric: "customer_satisfaction",
      value: 7.9,
      notes: "Support tickets spike after recent release",
    },
  ],
};

export const detailedMessageBriefPayload: MessageBriefRequest = {
  tenantId: "tenant-1",
  outputLocale: "en",
  objective: "Re-engage customers who have not used the product in 21+ days",
  audience: "recently inactive enterprise customers in the US",
  channelHints: ["email", "sms", "in-app"],
  constraints: [
    "do not mention pricing",
    "keep message under 120 words",
    "avoid urgency language for non-enterprise users",
  ],
};

export const detailedOutcomeDiagnosePayload: OutcomeDiagnoseRequest = {
  tenantId: "tenant-1",
  outputLocale: "en",
  expected: {
    monthlyRecurringRevenue: 56000,
    churnRate: 0.03,
    productUsage: {
      dailyActiveUsers: 820,
      featureAdoption: {
        analytics: 0.62,
        automation: 0.41,
      },
    },
  },
  observed: {
    monthlyRecurringRevenue: 51000,
    churnRate: 0.065,
    productUsage: {
      dailyActiveUsers: 640,
      featureAdoption: {
        analytics: 0.45,
        automation: 0.18,
      },
    },
    recentSupportVolume: 14,
    customerSentiment: "mixed",
  },
};

export const invalidGrowthNextActionPayload = {
  subjectId: 123,
  signals: [{ kind: "number", name: "unknown", value: "high" }],
} as unknown;

export const invalidGrowthSignalSummarizePayload = {
  signals: [{ kind: "string", name: "intent", value: 1 }],
} as unknown;

export const invalidJourneyCriticPayload = {
  journeyState: "not-an-object",
  priorActions: [],
  outcomes: [],
} as unknown;

export const invalidMessageBriefPayload = {
  objective: null,
  audience: 42,
} as unknown;

export const invalidOutcomeDiagnosePayload = {
  expected: "missing-record",
  observed: null,
} as unknown;
