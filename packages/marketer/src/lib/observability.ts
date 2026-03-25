import type { Env } from '../types';
import { KV_PREFIX, TTL } from '../constants';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export async function logEvent(
  env: Env,
  name: string,
  payload: Record<string, unknown>,
  level: LogLevel = 'info'
): Promise<void> {
  const record = {
    name,
    level,
    at: new Date().toISOString(),
    payload,
  };

  const line = `[Obs] ${name} ${JSON.stringify(payload)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (level === 'debug') console.debug(line);
  else console.log(line);

  // Keep a short rolling log in KV for forensic inspection.
  const key = `${KV_PREFIX.AUTH_NONCE}obs:${record.at}:${Math.random().toString(36).slice(2, 8)}`;
  try {
    await env.KV_MARKETING.put(key, JSON.stringify(record), { expirationTtl: TTL.DAYS_7 });
  } catch {
    // Telemetry must never interrupt business logic.
  }
}
