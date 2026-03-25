import type { Env } from '../../types';
import { ok } from '../../lib/response';
import { query } from '../../lib/db';
import { PAGINATION } from '../../constants';

export async function handleListContacts(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const page = parseInt(url.searchParams.get('page') ?? '1', 10);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? String(PAGINATION.DEFAULT_PAGE_SIZE), 10), PAGINATION.MAX_PAGE_SIZE);
  const offset = (page - 1) * limit;

  let sql = `SELECT * FROM marketing_contacts`;
  const params: unknown[] = [];

  if (status) {
    sql += ` WHERE status = ?`;
    params.push(status);
  }

  sql += ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const contacts = await query(env.DB, sql, params);

  return ok({ contacts, page, limit });
}

export async function handleListNotifications(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? String(PAGINATION.DEFAULT_PAGE_SIZE), 10), PAGINATION.MAX_PAGE_SIZE);

  const notifications = await query(
    env.DB,
    `SELECT * FROM notification_log ORDER BY created_at DESC LIMIT ?`,
    [limit]
  );

  return ok({ notifications, limit });
}
