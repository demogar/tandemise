import type { Migration } from './types.js';

/**
 * Hard limits on spend and time (P8 spec §4).
 *
 * Additive only:
 *
 *  - `missions.limits` is the mission's own list of limits as JSON; NULL means
 *    the project's default mission limits apply, so changing the default
 *    reaches every mission that never set its own.
 *  - `workspaces.default_mission_limits` and `workspaces.monthly_limits` are
 *    JSON lists, empty for every existing project: nothing stops until a
 *    person sets a limit.
 *  - `limit_incidents` records each limit crossed. The unique index is the
 *    "one incident per scope, metric, window, threshold and limit" rule the
 *    daemon relies on: a second crossing of the same limit finds the row
 *    instead of opening another card. `mission_id` is NULL for the project's
 *    monthly limit, and SQLite treats NULLs as distinct in a UNIQUE
 *    constraint, so the index reads it through `COALESCE`. `amount_limit` is in
 *    the key because raising a limit and crossing the new one is a new event.
 *  - `usage_records` gains an index by run time for the monthly sum.
 */
export const migration014: Migration = {
  version: 14,
  name: 'limits',
  up: `
ALTER TABLE missions ADD COLUMN limits TEXT;
ALTER TABLE workspaces ADD COLUMN default_mission_limits TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspaces ADD COLUMN monthly_limits TEXT NOT NULL DEFAULT '[]';

CREATE TABLE limit_incidents (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id       TEXT REFERENCES missions(id) ON DELETE CASCADE,
  metric           TEXT NOT NULL CHECK (metric IN ('agent_minutes','tokens','usd')),
  window_start     TEXT NOT NULL,
  window_end       TEXT,
  amount_limit     REAL NOT NULL CHECK (amount_limit > 0),
  amount_observed  REAL NOT NULL,
  threshold        TEXT NOT NULL CHECK (threshold IN ('soft','hard')),
  status           TEXT NOT NULL CHECK (status IN ('open','resolved','dismissed')),
  approval_id      TEXT,
  paused_missions  TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL,
  resolved_at      TEXT
);
CREATE UNIQUE INDEX ux_limit_incidents_scope
  ON limit_incidents (workspace_id, COALESCE(mission_id, ''), metric, window_start, threshold, amount_limit);
CREATE INDEX ix_limit_incidents_open ON limit_incidents (workspace_id, status);
CREATE INDEX ix_limit_incidents_approval ON limit_incidents (approval_id);

CREATE INDEX ix_usage_records_recorded ON usage_records (recorded_at);
`,
};
