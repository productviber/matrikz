import { SKRIP_CHANNEL } from '../../constants';
import { sha256Hex } from '../skrip/signing';

export const SEGMENT_FIELDS = [
  'language',
  'lastSeenDays',
  'bookingCount',
  'routeAffinity',
  'channelOptIn',
  'appInstalled',
] as const;

export const SEGMENT_OPERATORS = [
  'equals',
  'not_equals',
  'in',
  'not_in',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
] as const;

export const CHANNEL_LABELS = {
  [SKRIP_CHANNEL.EMAIL]: { key: 'campaign.channel.email', defaultLabel: 'Email' },
  [SKRIP_CHANNEL.PUSH]: { key: 'campaign.channel.push', defaultLabel: 'Push' },
  [SKRIP_CHANNEL.SMS]: { key: 'campaign.channel.sms', defaultLabel: 'SMS' },
  [SKRIP_CHANNEL.WHATSAPP]: { key: 'campaign.channel.whatsapp', defaultLabel: 'WhatsApp' },
  [SKRIP_CHANNEL.TELEGRAM]: { key: 'campaign.channel.telegram', defaultLabel: 'Telegram' },
} as const;

export const CHANNEL_OPTIONS = Object.keys(CHANNEL_LABELS) as CampaignChannel[];
export const DIRECT_STRATEGIC_CHANNELS = CHANNEL_OPTIONS.filter((channel) => channel !== SKRIP_CHANNEL.EMAIL);
export const MAX_SEGMENT_CONDITIONS = 20;
export const MAX_STRATEGIC_LIST_ITEMS = 12;
export const CAMPAIGN_PLANNING_I18N = {
  compatibility: {
    emailOnlyWarningKey: 'campaign.channel.warning.email_only',
    emailOnlyWarningDefault:
      'Email-only intent is saved, but Skrip strategic dispatch currently sends directly through push, WhatsApp, Telegram, and SMS.',
  },
} as const;

export type CampaignChannel = keyof typeof CHANNEL_LABELS;
export type SegmentField = typeof SEGMENT_FIELDS[number];
export type SegmentOperator = typeof SEGMENT_OPERATORS[number];

export interface SegmentCondition {
  field: SegmentField;
  operator: SegmentOperator;
  value: unknown;
}

export interface SegmentDefinition {
  includeConditions: SegmentCondition[];
  excludeConditions: SegmentCondition[];
}

export interface ChannelIntentProfile {
  hardBlockChannels: CampaignChannel[];
  preferredChannels: CampaignChannel[];
  fallbackChannels: CampaignChannel[];
}

export interface ChannelAvailability {
  email?: boolean;
  push?: boolean;
  sms?: boolean;
  whatsapp?: boolean;
  telegram?: boolean;
}

export interface ResolvedChannelIntent {
  selectedChannel: CampaignChannel | null;
  orderedCandidates: CampaignChannel[];
  blockedChannels: CampaignChannel[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSegmentField(value: string): value is SegmentField {
  return (SEGMENT_FIELDS as readonly string[]).includes(value);
}

function isSegmentOperator(value: string): value is SegmentOperator {
  return (SEGMENT_OPERATORS as readonly string[]).includes(value);
}

function isCampaignChannel(value: string): value is CampaignChannel {
  return CHANNEL_OPTIONS.includes(value as CampaignChannel);
}

function stableSortStrings(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (isRecord(value)) {
    return Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = stableJsonValue(value[key]);
        return accumulator;
      }, {});
  }
  return value;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function normalizeScalar(value: unknown): string | number | boolean | null {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === null) return null;
  return stableJsonStringify(value);
}

function normalizeConditionValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return stableSortStrings(
      value
        .map((entry) => normalizeScalar(entry))
        .filter((entry): entry is string | number | boolean | null => entry !== undefined)
        .map((entry) => String(entry)),
    );
  }
  return normalizeScalar(value);
}

export function parseSegmentDefinition(payload: unknown): SegmentDefinition {
  const record = isRecord(payload) ? payload : {};
  return {
    includeConditions: parseConditions(record.includeConditions),
    excludeConditions: parseConditions(record.excludeConditions),
  };
}

function parseConditions(value: unknown): SegmentCondition[] {
  if (!Array.isArray(value)) return [];
  const normalized: SegmentCondition[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const field = typeof entry.field === 'string' ? entry.field.trim() : '';
    const operator = typeof entry.operator === 'string' ? entry.operator.trim() : '';
    if (!isSegmentField(field) || !isSegmentOperator(operator)) continue;
    normalized.push({
      field,
      operator,
      value: normalizeConditionValue(entry.value),
    });
  }
  return normalized;
}

export function canonicalizeSegmentDefinition(definition: SegmentDefinition): SegmentDefinition {
  const sortConditions = (conditions: SegmentCondition[]): SegmentCondition[] => {
    return [...conditions].sort((left, right) => {
      const leftKey = `${left.field}|${left.operator}|${stableJsonStringify(left.value)}`;
      const rightKey = `${right.field}|${right.operator}|${stableJsonStringify(right.value)}`;
      return leftKey.localeCompare(rightKey);
    });
  };

  return {
    includeConditions: sortConditions(definition.includeConditions),
    excludeConditions: sortConditions(definition.excludeConditions),
  };
}

export function serializeSegmentDefinition(definition: SegmentDefinition): string {
  return stableJsonStringify(canonicalizeSegmentDefinition(definition));
}

export async function computeSegmentHash(definition: SegmentDefinition): Promise<string> {
  return sha256Hex(serializeSegmentDefinition(definition));
}

function numericBounds(conditions: SegmentCondition[], field: SegmentField): {
  min: number | null;
  minInclusive: boolean;
  max: number | null;
  maxInclusive: boolean;
} {
  const state = {
    min: null as number | null,
    minInclusive: true,
    max: null as number | null,
    maxInclusive: true,
  };

  for (const condition of conditions.filter((entry) => entry.field === field && typeof entry.value === 'number')) {
    const value = condition.value as number;
    if (condition.operator === 'gt') {
      if (state.min === null || value > state.min || (value === state.min && state.minInclusive)) {
        state.min = value;
        state.minInclusive = false;
      }
    }
    if (condition.operator === 'gte') {
      if (state.min === null || value > state.min || (value === state.min && !state.minInclusive)) {
        state.min = value;
        state.minInclusive = true;
      }
    }
    if (condition.operator === 'lt') {
      if (state.max === null || value < state.max || (value === state.max && state.maxInclusive)) {
        state.max = value;
        state.maxInclusive = false;
      }
    }
    if (condition.operator === 'lte') {
      if (state.max === null || value < state.max || (value === state.max && !state.maxInclusive)) {
        state.max = value;
        state.maxInclusive = true;
      }
    }
  }

  return state;
}

export function detectSegmentContradictions(definition: SegmentDefinition): string[] {
  const contradictions: string[] = [];
  const canonical = canonicalizeSegmentDefinition(definition);
  const includeEquals = new Map<string, string>();
  const excludeKeys = new Set<string>();

  for (const condition of canonical.excludeConditions) {
    excludeKeys.add(`${condition.field}|${stableJsonStringify(condition.value)}`);
  }

  for (const condition of canonical.includeConditions) {
    if (condition.operator === 'equals') {
      includeEquals.set(condition.field, stableJsonStringify(condition.value));
      const key = `${condition.field}|${stableJsonStringify(condition.value)}`;
      if (excludeKeys.has(key)) {
        contradictions.push(`${condition.field} both includes and excludes ${stableJsonStringify(condition.value)}.`);
      }
    }
  }

  for (const field of ['lastSeenDays', 'bookingCount'] as SegmentField[]) {
    const bounds = numericBounds(canonical.includeConditions, field);
    if (
      bounds.min !== null &&
      bounds.max !== null &&
      (bounds.min > bounds.max || (bounds.min === bounds.max && (!bounds.minInclusive || !bounds.maxInclusive)))
    ) {
      contradictions.push(`${field} range is impossible because the minimum is higher than the maximum.`);
    }

    const equalsCondition = canonical.includeConditions.find((condition) => condition.field === field && condition.operator === 'equals' && typeof condition.value === 'number');
    if (equalsCondition && typeof equalsCondition.value === 'number') {
      const value = equalsCondition.value;
      if (bounds.min !== null && (value < bounds.min || (value === bounds.min && !bounds.minInclusive))) {
        contradictions.push(`${field} equals ${value} conflicts with the minimum bound.`);
      }
      if (bounds.max !== null && (value > bounds.max || (value === bounds.max && !bounds.maxInclusive))) {
        contradictions.push(`${field} equals ${value} conflicts with the maximum bound.`);
      }
    }
  }

  return stableSortStrings(Array.from(new Set(contradictions)));
}

export function estimateAudienceSize(hash: string, totalConditions: number): number {
  const seed = Number.parseInt(hash.slice(0, 8), 16);
  const base = Number.isFinite(seed) ? seed : 10_000;
  return Math.max(125, (base % 40_000) + 750 - totalConditions * 40);
}

export function normalizeChannelList(value: unknown): CampaignChannel[] {
  if (!Array.isArray(value)) return [];
  const channels = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase())
    .filter(isCampaignChannel);
  return Array.from(new Set(channels));
}

export function normalizeChannelIntentProfile(payload: unknown): ChannelIntentProfile {
  const record = isRecord(payload) ? payload : {};
  return {
    hardBlockChannels: normalizeChannelList(record.hardBlockChannels),
    preferredChannels: normalizeChannelList(record.preferredChannels),
    fallbackChannels: normalizeChannelList(record.fallbackChannels),
  };
}

export function getChannelCompatibilityWarnings(profile: ChannelIntentProfile): string[] {
  if (
    profile.preferredChannels.length === 1 &&
    profile.preferredChannels[0] === SKRIP_CHANNEL.EMAIL &&
    profile.fallbackChannels.length === 0
  ) {
    return [CAMPAIGN_PLANNING_I18N.compatibility.emailOnlyWarningDefault];
  }
  return [];
}

export function resolveChannelIntent(
  profile: ChannelIntentProfile,
  availability: ChannelAvailability,
): ResolvedChannelIntent {
  const blockedChannels = profile.hardBlockChannels;
  const orderedCandidates = [
    ...profile.preferredChannels,
    ...profile.fallbackChannels.filter((channel) => !profile.preferredChannels.includes(channel)),
  ].filter((channel) => !blockedChannels.includes(channel));

  const selectedChannel = orderedCandidates.find((channel) => availability[channel] === true) ?? null;
  return {
    selectedChannel,
    orderedCandidates,
    blockedChannels,
  };
}

export function totalSegmentConditions(definition: SegmentDefinition): number {
  return definition.includeConditions.length + definition.excludeConditions.length;
}
