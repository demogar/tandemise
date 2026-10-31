import type { Migration } from './types.js';

/**
 * The brain (#51): one git repository per project for memory and the factory.
 *
 * Additive only, and every brain table ships here so later steps need no
 * migration (024 and 025 belong to other work):
 *
 *  - `workspace_brains`: a project's link to its brain on this machine;
 *  - `runs.brain`: what a run knew (sha, rules, lessons loaded, fetched, proposed);
 *  - `brain_passes`: reflector and promoter model passes with their usage;
 *  - `brain_proposals`: promotions of lessons to rules;
 *  - `measured_usage`: `usage_records` plus the passes that belong to a
 *    mission, so a reflector's spend counts toward P8 limits like any run's.
 *    A pass has no `runs` row, and `usage_records.run_id` references `runs`.
 *    A promoter pass belongs to no mission: it counts toward its project's month.
 */
export const migration023: Migration = {
  version: 23,
  name: 'brain',
  up: `
CREATE TABLE workspace_brains (
  workspace_id     TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  remote           TEXT,
  default_branch   TEXT NOT NULL,
  clone_path       TEXT NOT NULL,
  writer_id        TEXT NOT NULL,
  last_pulled_sha  TEXT,
  last_pushed_sha  TEXT,
  last_sync_at     TEXT,
  last_sync_error  TEXT,
  fallback_branch  TEXT,
  linked_at        TEXT NOT NULL
);

ALTER TABLE runs ADD COLUMN brain TEXT;

CREATE TABLE brain_passes (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id         TEXT,
  task_id            TEXT,
  kind               TEXT NOT NULL CHECK (kind IN ('reflect','promote')),
  signal             TEXT NOT NULL,
  runtime_profile_id TEXT,
  model              TEXT,
  status             TEXT NOT NULL CHECK (status IN ('ok','failed','skipped')),
  reason             TEXT,
  has_usage          INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  cost_usd           REAL,
  wall_time_ms       INTEGER,
  created_at         TEXT NOT NULL
);
CREATE INDEX ix_brain_passes_workspace ON brain_passes (workspace_id, created_at);

CREATE TABLE brain_proposals (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lesson_ids      TEXT NOT NULL,
  targets         TEXT NOT NULL,
  classification  TEXT NOT NULL CHECK (classification IN ('small','structural')),
  reasons         TEXT NOT NULL,
  branch          TEXT NOT NULL,
  state           TEXT NOT NULL,
  eval_run_id     TEXT,
  verdict         TEXT,
  pr_url          TEXT,
  applied_sha     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX ix_brain_proposals_workspace ON brain_proposals (workspace_id, updated_at);

CREATE VIEW measured_usage AS
  SELECT id, mission_id, NULL AS workspace_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cost_usd, wall_time_ms, turns, recorded_at
    FROM usage_records
  UNION ALL
  SELECT id, mission_id, workspace_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cost_usd, wall_time_ms, NULL AS turns, created_at AS recorded_at
    FROM brain_passes
   WHERE has_usage = 1;
`,
};
