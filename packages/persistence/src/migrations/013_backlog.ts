import type { Migration } from './types.js';

/**
 * The backlog (P7 spec §3).
 *
 * Every change is a column added, so nothing is copied or rebuilt:
 *
 *  - `missions.priority` and `missions.rank` order the backlog and the worker
 *    slots. Existing missions read `normal` and are ranked 1…n per project in
 *    the order they were created, which is the order a person saw them in -
 *    so nothing jumps ahead the moment this migration runs.
 *  - `missions.queued_at` marks a DRAFT the person queued (roadmap decision 3:
 *    the backlog is DRAFT plus this column, not a new status).
 *  - `workspaces.max_active_missions` is the work-in-progress limit. NULL is
 *    off (decision 4), which is what every existing project gets: no mission
 *    is pulled until a person sets a limit.
 */
export const migration013: Migration = {
  version: 13,
  name: 'backlog',
  up: `
ALTER TABLE missions ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'
  CHECK (priority IN ('urgent','high','normal','low'));
ALTER TABLE missions ADD COLUMN rank REAL NOT NULL DEFAULT 0;
ALTER TABLE missions ADD COLUMN queued_at TEXT;
ALTER TABLE workspaces ADD COLUMN max_active_missions INTEGER
  CHECK (max_active_missions IS NULL OR max_active_missions >= 1);

UPDATE missions SET rank = (
  SELECT COUNT(*) FROM missions AS earlier
   WHERE earlier.workspace_id = missions.workspace_id
     AND (earlier.created_at < missions.created_at
          OR (earlier.created_at = missions.created_at AND earlier.id <= missions.id))
);

CREATE INDEX ix_missions_backlog ON missions (workspace_id, status, priority, rank);
`,
};
