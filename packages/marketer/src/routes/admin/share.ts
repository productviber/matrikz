import type { Env } from '../../types';
import { ok, serverError } from '../../lib/response';
import { query, queryOne } from '../../lib/db';
import { PAGINATION } from '../../constants';

export async function handleListShareLeads(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const owner = url.searchParams.get('owner');
    const page = parseInt(url.searchParams.get('page') ?? '1', 10);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? String(PAGINATION.DEFAULT_PAGE_SIZE), 10), PAGINATION.MAX_PAGE_SIZE);
    const offset = (page - 1) * limit;

    let sql = `SELECT * FROM share_leads`;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) {
      conditions.push(`status = ?`);
      params.push(status);
    }
    if (owner) {
      conditions.push(`owner_email = ?`);
      params.push(owner);
    }

    if (conditions.length) {
      sql += ` WHERE ` + conditions.join(' AND ');
    }

    sql += ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const leads = await query(env.DB, sql, params);
    const total = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM share_leads` + (conditions.length ? ` WHERE ` + conditions.join(' AND ') : ''),
      conditions.length ? params.slice(0, conditions.length) : []
    );

    return ok({ leads, total: total?.count ?? 0, page, limit });
  } catch (err) {
    console.error('[Admin] handleListShareLeads error:', err);
    return serverError('Failed to load share leads');
  }
}

export async function handleListShareOwners(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') ?? '1', 10);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? String(PAGINATION.DEFAULT_PAGE_SIZE), 10), PAGINATION.MAX_PAGE_SIZE);
    const offset = (page - 1) * limit;

    const owners = await query(
      env.DB,
      `SELECT * FROM share_owner_stats ORDER BY total_conversions DESC, total_views DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    const total = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM share_owner_stats`
    );

    return ok({ owners, total: total?.count ?? 0, page, limit });
  } catch (err) {
    console.error('[Admin] handleListShareOwners error:', err);
    return serverError('Failed to load share owners');
  }
}

export async function handleListPQLLeads(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const minScore = parseInt(url.searchParams.get('minScore') ?? '50', 10);
    const page = parseInt(url.searchParams.get('page') ?? '1', 10);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? String(PAGINATION.DEFAULT_PAGE_SIZE), 10), PAGINATION.MAX_PAGE_SIZE);
    const offset = (page - 1) * limit;

    const leads = await query(
      env.DB,
      `SELECT * FROM share_leads WHERE pql_score >= ? AND status NOT IN ('converted', 'revoked')
       ORDER BY pql_score DESC LIMIT ? OFFSET ?`,
      [minScore, limit, offset]
    );
    const total = await queryOne<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) as count FROM share_leads WHERE pql_score >= ? AND status NOT IN ('converted', 'revoked')`,
      [minScore]
    );

    return ok({ leads, total: total?.count ?? 0, minScore, page, limit });
  } catch (err) {
    console.error('[Admin] handleListPQLLeads error:', err);
    return serverError('Failed to load PQL leads');
  }
}
