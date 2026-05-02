import type { Env } from '../../types';
import { KV_PREFIX } from '../../constants';

export interface SkripFlagSnapshot {
  globalEnabled: boolean;
  tenantEnabled: boolean | null;
  campaignEnabled: boolean | null;
  channelEnabled: boolean | null;
  effectiveEnabled: boolean;
}

function parseBoolean(input: string | null | undefined): boolean | null {
  if (input == null) return null;
  const normalized = input.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'enabled') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'disabled') return false;
  return null;
}

function defaultGlobalFlag(env: Env): boolean {
  return parseBoolean(env.SKRIP_DEFAULT_ENABLEMENT) ?? false;
}

async function readFlag(env: Env, suffix: string): Promise<boolean | null> {
  const raw = await env.KV_MARKETING.get(`${KV_PREFIX.SKRIP_FLAG}${suffix}`);
  return parseBoolean(raw);
}

export async function getSkripFlagSnapshot(
  env: Env,
  tenantId: string,
  campaignId?: string | null,
  channel?: string | null,
): Promise<SkripFlagSnapshot> {
  const globalEnabled = defaultGlobalFlag(env);
  const tenantEnabled = await readFlag(env, `tenant:${tenantId}`);
  const campaignEnabled = campaignId ? await readFlag(env, `tenant:${tenantId}:campaign:${campaignId}`) : null;
  const channelEnabled = channel ? await readFlag(env, `tenant:${tenantId}:channel:${channel}`) : null;

  const effectiveEnabled = [tenantEnabled, campaignEnabled, channelEnabled]
    .filter((value) => value !== null)
    .every((value) => value === true) && (tenantEnabled !== null || campaignEnabled !== null || channelEnabled !== null)
    ? true
    : globalEnabled && tenantEnabled !== false && campaignEnabled !== false && channelEnabled !== false;

  return {
    globalEnabled,
    tenantEnabled,
    campaignEnabled,
    channelEnabled,
    effectiveEnabled,
  };
}
