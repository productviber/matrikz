// KV Cache utilities
import type { KVNamespace } from '@cloudflare/workers-types'

export interface CacheOptions {
  ttl?: number // seconds
}

export class CacheManager {
  constructor(private kv: KVNamespace) {}

  async get<T>(key: string): Promise<T | null> {
    const value = await this.kv.get(key)
    if (!value) return null
    try {
      return JSON.parse(value) as T
    } catch {
      return null
    }
  }

  async set<T>(
    key: string,
    value: T,
    options?: CacheOptions
  ): Promise<void> {
    await this.kv.put(key, JSON.stringify(value), {
      expirationTtl: options?.ttl || 3600, // default 1 hour
    })
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key)
  }

  async exists(key: string): Promise<boolean> {
    const value = await this.kv.get(key)
    return value !== null
  }

  generateKey(...parts: string[]): string {
    return parts.join(':')
  }
}
