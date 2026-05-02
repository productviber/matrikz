import type { Env } from '../../types';
import { ok } from '../../lib/response';
import { query, queryOne } from '../../lib/db';
import { PAGINATION } from '../../constants';

export async function handleListContacts(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const rawPage = parseInt(url.searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const rawLimit = parseInt(url.searchParams.get('limit') ?? String(PAGINATION.DEFAULT_PAGE_SIZE), 10);
  const limit = Math.min(
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : PAGINATION.DEFAULT_PAGE_SIZE,
    PAGINATION.MAX_PAGE_SIZE
  );
  const offset = (page - 1) * limit;

  const whereClause = status ? ` WHERE status = ?` : '';
  const whereParams: unknown[] = status ? [status] : [];

  // Total count (for pager "Page N of M") — runs in parallel with the page query.
  const countPromise = queryOne<{ total: number }>(
    env.DB,
    `SELECT COUNT(*) AS total FROM marketing_contacts${whereClause}`,
    whereParams
  );

  const rowsPromise = query(
    env.DB,
    `SELECT * FROM marketing_contacts${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    [...whereParams, limit, offset]
  );

  const [countRow, contacts] = await Promise.all([countPromise, rowsPromise]);
  const total = Number(countRow?.total ?? 0);
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  const hasMore = page < totalPages;

  return ok({ contacts, page, limit, total, totalPages, hasMore });
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
