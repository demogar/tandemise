import type { Migration } from './types.js';

/**
 * Routines (P11 spec §3).
 *
 * Additive only:
 *
 *  - `routines` is standing work: what each mission it creates says (goal,
 *    Done-when lines, priority, limits, workflow) and when it repeats. The
 *    schedule is JSON because it is one of three preset shapes, never cron.
 *    `next_run_at` is NULL while a routine is off, which is what keeps a paused
 *    routine out of the due index entirely.
 *  - `routine_runs` is the note of every run, skipped and missed ones included,
 *    so "skipped and noted" is a row the window reads rather than a log line.
 *    A downtime's missed slots are one row with a count.
 *  - `missions.routine_id` says which routine created a mission; deleting the
 *    routine leaves its missions as ordinary missions.
 */
export const migration016: Migration = {
  version: 16,
  name: 'routines',
  up: `
CREATE TABLE routines (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('mission','status_report')),
  goal              TEXT NOT NULL DEFAULT '',
  success_criteria  TEXT NOT NULL DEFAULT '[]',
  priority          TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low')),
  limits            TEXT,
  workflow_preset   TEXT,
  schedule          TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  next_run_at       TEXT,
  last_run_at       TEXT,
  last_outcome      TEXT CHECK (last_outcome IS NULL OR last_outcome IN ('created','reported','skipped_active','skipped_limit','missed','failed')),
  last_detail       TEXT,
  last_mission_id   TEXT REFERENCES missions(id) ON DELETE SET NULL,
  last_artifact_id  TEXT,
  created_by        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX ix_routines_workspace ON routines (workspace_id, created_at);
CREATE INDEX ix_routines_due ON routines (enabled, next_run_at);

CREATE TABLE routine_runs (
  id             TEXT PRIMARY KEY,
  routine_id     TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  trigger        TEXT NOT NULL CHECK (trigger IN ('schedule','manual')),
  scheduled_for  TEXT,
  ran_at         TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('created','reported','skipped_active','skipped_limit','missed','failed')),
  detail         TEXT NOT NULL,
  skipped_count  INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  mission_id     TEXT,
  artifact_id    TEXT
);
CREATE INDEX ix_routine_runs_routine ON routine_runs (routine_id, ran_at);

ALTER TABLE missions ADD COLUMN routine_id TEXT REFERENCES routines(id) ON DELETE SET NULL;
CREATE INDEX ix_missions_routine ON missions (routine_id);
`,
};
