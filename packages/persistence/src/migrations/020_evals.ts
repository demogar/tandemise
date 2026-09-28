import type { Migration } from './types.js';

/**
 * Evals (P3 spec Part B, §B6).
 *
 * Additive only:
 *
 *  - `run_scores` keeps one row of measured facts per assessed run. It is a
 *    record: the engine never reads it. `eval_trial` is denormalised so "From
 *    your runs" can leave trials out without joining missions.
 *  - `eval_suites` / `eval_cases` hold saved cases. A case's snapshot is JSON
 *    and names its inputs by content hash, so it outlives its source mission.
 *  - `eval_runs` / `eval_trials` hold one suite × {baseline, candidate} ×
 *    repeats. Variants are frozen on the run so later role edits don't change
 *    a run in flight.
 *  - `missions.eval_trial_id` marks a hidden trial mission.
 */
export const migration020: Migration = {
  version: 20,
  name: 'evals',
  up: `
CREATE TABLE run_scores (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL,
  model TEXT,
  skills TEXT NOT NULL DEFAULT '[]',
  attempt INTEGER NOT NULL,
  round INTEGER NOT NULL,
  purpose TEXT,
  gate_passed INTEGER NOT NULL CHECK (gate_passed IN (0,1)),
  gate_detail TEXT NOT NULL,
  facts TEXT NOT NULL DEFAULT '{}',
  criteria_verified INTEGER,
  criteria_failed INTEGER,
  criteria_unverified INTEGER,
  over_budget INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  wall_time_ms INTEGER,
  eval_trial INTEGER NOT NULL DEFAULT 0 CHECK (eval_trial IN (0,1)),
  scored_at TEXT NOT NULL
);
CREATE INDEX ix_run_scores_workspace ON run_scores(workspace_id, scored_at);
CREATE INDEX ix_run_scores_task ON run_scores(task_id);

CREATE TABLE eval_suites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE eval_cases (
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  provenance TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_eval_cases_suite ON eval_cases(suite_id);

CREATE TABLE eval_runs (
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','cancelled','stopped_at_cap','failed')),
  reason TEXT,
  repeats INTEGER NOT NULL CHECK (repeats BETWEEN 1 AND 10),
  spend_cap_usd REAL NOT NULL CHECK (spend_cap_usd > 0),
  candidate TEXT NOT NULL,
  variants TEXT NOT NULL,
  scorecard TEXT,
  started_by TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX ix_eval_runs_suite ON eval_runs(suite_id, created_at);

CREATE TABLE eval_trials (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('baseline','candidate')),
  repeat INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','passed','failed','blocked','cancelled')),
  reason TEXT,
  score TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX ix_eval_trials_run ON eval_trials(run_id, seq);

ALTER TABLE missions ADD COLUMN eval_trial_id TEXT;
CREATE INDEX ix_missions_eval_trial ON missions(eval_trial_id);
`,
};
