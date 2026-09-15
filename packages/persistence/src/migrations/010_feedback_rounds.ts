import type { Migration } from './types.js';

/**
 * Feedback and rounds (P2 spec §7).
 *
 * `feedback` holds what people (and AI reviewers) asked a task to change. The
 * text limit is enforced here as well as at the API edge because an item is
 * quoted into prompts verbatim, and a row that bypassed the API must not blow
 * the context budget. Items cascade with their task: feedback about a task
 * that no longer exists has nothing to address.
 *
 * `run_inputs` records which artifacts a run was actually given, from the
 * context compiler's `includedArtifactIds`. Downstream impact is read from
 * it rather than guessed from the plan; runs from before this migration have
 * none, and the engine falls back to an inference only for them (their
 * `runs.round` is NULL, which is how it tells them apart).
 *
 * `artifacts.withdrawn_at` marks the output of a pass that was overtaken
 * before it was judged (a Redo reset its task mid-settle). Such a row is kept,
 * so the timeline's links still open, but no list returns it: it was never
 * the task's output.
 *
 * Nothing is copied or rebuilt: every change is an added table or column, so
 * the generated `artifacts.handoff_text` column and its FTS triggers from 009
 * are untouched.
 */
export const migration010: Migration = {
  version: 10,
  name: 'feedback_rounds',
  up: `
CREATE TABLE feedback (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES mission_tasks(id) ON DELETE CASCADE,
  artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  author_id   TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  text        TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  attachments TEXT NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL CHECK (status IN ('open','queued','in_round','addressed','dismissed')),
  round       INTEGER CHECK (round IS NULL OR round >= 1),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX ix_feedback_task   ON feedback (task_id, created_at);
CREATE INDEX ix_feedback_status ON feedback (status);

ALTER TABLE mission_tasks ADD COLUMN round INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1);
ALTER TABLE artifacts ADD COLUMN round INTEGER;
ALTER TABLE artifacts ADD COLUMN withdrawn_at TEXT;
ALTER TABLE runs ADD COLUMN round INTEGER;
ALTER TABLE runs ADD COLUMN purpose TEXT CHECK (purpose IS NULL OR purpose IN ('round','tighten','feedback','retry'));

CREATE TABLE run_inputs (
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  PRIMARY KEY (run_id, artifact_id)
) WITHOUT ROWID;
CREATE INDEX ix_run_inputs_artifact ON run_inputs (artifact_id);
`,
};
