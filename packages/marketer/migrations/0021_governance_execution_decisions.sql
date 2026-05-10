-- Migration 0021: Governance Execution Decisions
-- Purpose: Audit table for execution-path governance decisions on state-changing
--          agent actions (enroll_sequence, send_via_skrip, start_campaign,
--          pause_campaign, pause_contact, channel subscribe flows).
--
-- Companion to governance_ingress_decisions (0020) which gates event ingress.
-- This table captures the execution layer decision so violations, mode trends,
-- and action-type distributions are fully observable via the SLO endpoint.

CREATE TABLE IF NOT EXISTS governance_execution_decisions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id         TEXT    NOT NULL UNIQUE,
  governance_mode     TEXT    NOT NULL,   -- off | observe | enforce
  action_type         TEXT    NOT NULL,   -- enroll_sequence | send_via_skrip | ...
  actor_tenant_id     TEXT,
  target_tenant_id    TEXT,
  tenant_scope        TEXT,               -- denormalized: target_tenant_id ?? actor_tenant_id
  allowed             INTEGER NOT NULL DEFAULT 1,  -- 1 = allowed, 0 = blocked
  enforcement_outcome TEXT    NOT NULL,   -- bypassed | allowed | blocked | observed
  reason              TEXT    NOT NULL,   -- bypass_mode_off | allowed_by_service | denied_by_service | ...
  policy_version      TEXT,               -- version string returned by governance service
  token_present       INTEGER NOT NULL DEFAULT 0,  -- 1 if signedDecisionToken returned
  violation           INTEGER NOT NULL DEFAULT 0,  -- 1 = service said denied (observe-mode violations)
  recorded_at         INTEGER NOT NULL    -- Unix epoch seconds
);

CREATE INDEX IF NOT EXISTS idx_gov_exec_decisions_recorded
  ON governance_execution_decisions(recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_gov_exec_decisions_action
  ON governance_execution_decisions(action_type, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_gov_exec_decisions_tenant
  ON governance_execution_decisions(tenant_scope, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_gov_exec_decisions_violation
  ON governance_execution_decisions(violation, recorded_at DESC)
  WHERE violation = 1;
