// D1 Database utilities
import type { D1Database } from '@cloudflare/workers-types'

export interface User {
  id: string
  email: string
  name: string
  subscription_tier: string
  trial_ends_at: number | null
  created_at: number
}

export interface Site {
  id: string
  user_id: string
  domain: string
  health_score: number
  domain_authority: number
  last_analyzed_at: number
}

export interface MetricRow {
  date: string
  metric: string
  value: number
}

export class Database {
  constructor(private db: D1Database) {}

  async getUser(userId: string): Promise<User | null> {
    const result = await this.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first<User>()
    return result || null
  }

  async getUserSites(userId: string): Promise<Site[]> {
    const result = await this.db
      .prepare('SELECT * FROM sites WHERE user_id = ? ORDER BY last_analyzed_at DESC')
      .bind(userId)
      .all<Site>()
    return result?.results || []
  }

  async getSiteMetrics(
    siteId: string,
    metricName: string,
    days: number = 30
  ): Promise<MetricRow[]> {
    const result = await this.db
      .prepare(
        `SELECT date, metric, value FROM gsc_data 
         WHERE site_id = ? AND metric = ? 
         AND date >= date('now', '-${days} days')
         ORDER BY date DESC`
      )
      .bind(siteId, metricName)
      .all<MetricRow>()
    return result?.results || []
  }

  async updateSiteHealthScore(siteId: string, score: number): Promise<void> {
    await this.db
      .prepare('UPDATE sites SET health_score = ?, last_analyzed_at = ? WHERE id = ?')
      .bind(score, Date.now(), siteId)
      .run()
  }
}
