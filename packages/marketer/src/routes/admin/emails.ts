import type { Env } from '../../types';
import { ok, serverError } from '../../lib/response';
import { query } from '../../lib/db';
import { processDueEmails } from '../../lib/email';
import { PAGINATION, MESSAGES } from '../../constants';
import { parsePositiveIntParam } from './admin-lib';

export async function handleListSequences(
  request: Request,
  env: Env
): Promise<Response> {
  const sequences = await query<{
    id: number;
    name: string;
    trigger_event: string;
    is_active: number;
    step_count: number;
    created_at: number;
  }>(
    env.DB,
    `SELECT es.*, COUNT(est.id) as step_count
     FROM email_sequences es
     LEFT JOIN email_steps est ON es.id = est.sequence_id
     GROUP BY es.id
     ORDER BY es.id`
  );

  return ok({ sequences });
}

export async function handleListEmailSends(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const limit = parsePositiveIntParam(
    url.searchParams.get('limit'),
    PAGINATION.DEFAULT_PAGE_SIZE,
    PAGINATION.MAX_PAGE_SIZE
  );

  let sql = `SELECT es.*, est.subject, est.template_key, seq.name as sequence_name
     FROM email_sends es
     JOIN email_steps est ON es.step_id = est.id
     JOIN email_sequences seq ON es.sequence_id = seq.id`;
  const params: unknown[] = [];

  if (status) {
    sql += ` WHERE es.status = ?`;
    params.push(status);
  }

  sql += ` ORDER BY es.created_at DESC LIMIT ?`;
  params.push(limit);

  const sends = await query(env.DB, sql, params);

  return ok({ sends, limit });
}

export async function handleProcessEmails(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const force = url.searchParams.get('force') === 'true';
    const sent = await processDueEmails(env, undefined, { force });
    return ok({ processed: sent, force, message: MESSAGES.success.processedEmails(sent) });
  } catch (err) {
    console.error('[Admin:ProcessEmails] Error:', err);
    return serverError(MESSAGES.errors.failedProcessEmails);
  }
}
