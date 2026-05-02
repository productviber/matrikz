import type { AgentActionRow, Env } from '../../types';
import { AGENT_ACTION_EVENT, AGENT_ACTION_STATUS, GROWTH_POLICY } from '../../constants';
import { execute, now, query } from '../db';
import { recordAgentActionEvent } from './actions';

export interface StaleActionReviewResult {
  scanned: number;
  marked: number;
  actionIds: string[];
}

export async function markStaleAgentActions(
  env: Env,
  limit: number = GROWTH_POLICY.DEFAULT_LIST_LIMIT,
): Promise<StaleActionReviewResult> {
  const epoch = now();
  const rows = await query<Pick<AgentActionRow, 'action_id' | 'outcome_due_at'>>(
    env.DB,
    `SELECT action_id, outcome_due_at
       FROM agent_actions
      WHERE status = ?
        AND outcome_due_at IS NOT NULL
        AND outcome_due_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM agent_action_outcomes o WHERE o.action_id = agent_actions.action_id
        )
      ORDER BY outcome_due_at ASC
      LIMIT ?`,
    [AGENT_ACTION_STATUS.EXECUTED, epoch, Math.max(1, Math.min(limit, GROWTH_POLICY.MAX_LIST_LIMIT))],
  );

  const actionIds: string[] = [];
  for (const row of rows) {
    await execute(
      env.DB,
      `INSERT OR IGNORE INTO agent_action_outcomes
        (action_id, outcome_type, observed_at, window_seconds, attribution_strength, revenue_or_value, evidence_json, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        row.action_id,
        AGENT_ACTION_STATUS.NO_OUTCOME_OBSERVED,
        epoch,
        GROWTH_POLICY.DEFAULT_OUTCOME_WINDOW_SECONDS,
        'none',
        JSON.stringify({ reason: 'outcome_window_elapsed', outcomeDueAt: row.outcome_due_at }),
        epoch,
      ],
    );
    await execute(
      env.DB,
      `UPDATE agent_actions SET status = ?, outcome_json = ?, updated_at = ? WHERE action_id = ?`,
      [
        AGENT_ACTION_STATUS.NO_OUTCOME_OBSERVED,
        JSON.stringify({ outcomeType: AGENT_ACTION_STATUS.NO_OUTCOME_OBSERVED, observedAt: epoch }),
        epoch,
        row.action_id,
      ],
    );
    await recordAgentActionEvent(env, row.action_id, AGENT_ACTION_EVENT.NO_OUTCOME_OBSERVED, {
      outcomeDueAt: row.outcome_due_at,
      observedAt: epoch,
    }, 'cron');
    actionIds.push(row.action_id);
  }

  return { scanned: rows.length, marked: actionIds.length, actionIds };
}