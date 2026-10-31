import { TandemiseError } from '@tandemise/shared';
import type { SqliteHandle } from '../database.js';
import type { Migration } from './types.js';

/**
 * The planner and risk-based merge (#53). Additive only:
 *
 *  - `missions.lane_request`: a person's Quick or Careful;
 *  - `mission_tasks.step_class`: what a step is for. `executor` has no CHECK
 *    (migration 003), so the `ship` executor needs no schema edit;
 *  - `mission_criteria.source` widened in place to accept `implicit`, exactly
 *    as migration 006 widened task statuses: a table rebuild would cascade
 *    away every criterion's history;
 *  - `plan_decisions`, `merge_decisions` (append-only but for five fields the
 *    merge fills in later) and `outcomes` (no foreign key: routing stats
 *    outlive a deleted mission).
 *
 * Numbered after 022 (holds, #50) and 023 (the brain, #51), by merge order.
 */
const OLD_SOURCES = `source IN ('user','spec')`;
const NEW_SOURCES = `source IN ('user','spec','implicit')`;

export const migration024: Migration = {
  version: 24,
  name: 'planner_and_merge',
  up: `
ALTER TABLE missions ADD COLUMN lane_request TEXT CHECK (lane_request IN ('quick','careful'));
ALTER TABLE mission_tasks ADD COLUMN step_class TEXT;

CREATE TABLE plan_decisions (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  policy_ref TEXT NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('predicted','measured')),
  profile TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('quick','standard','careful')),
  lane_because TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  modules TEXT NOT NULL,
  dropped TEXT NOT NULL,
  steps TEXT NOT NULL,
  approvals TEXT NOT NULL,
  skipped TEXT NOT NULL,
  tiebreak TEXT,
  lightened_by_person INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_plan_decisions_mission ON plan_decisions(mission_id, created_at);

CREATE TABLE merge_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  policy_ref TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('merge','ask')),
  score INTEGER NOT NULL,
  allowed INTEGER,
  would_merge INTEGER NOT NULL DEFAULT 0,
  factors TEXT NOT NULL,
  reasons TEXT NOT NULL DEFAULT '[]',
  facts TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  voided_at TEXT,
  comment_id INTEGER,
  merged_at TEXT,
  merged_by TEXT,
  merge_sha TEXT
);
CREATE INDEX idx_merge_decisions_workspace ON merge_decisions(workspace_id, decided_at);
CREATE INDEX idx_merge_decisions_mission ON merge_decisions(mission_id, repo);

CREATE TABLE outcomes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mission_id TEXT,
  at TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX idx_outcomes_workspace ON outcomes(workspace_id, at);
`,
  transform: (db: SqliteHandle): void => {
    db.unsafeMode(true);
    try {
      db.pragma('writable_schema = ON');
      try {
        db.prepare(
          `UPDATE sqlite_master SET sql = replace(sql, :old, :new) WHERE type = 'table' AND name = 'mission_criteria'`,
        ).run({ old: OLD_SOURCES, new: NEW_SOURCES });
      } finally {
        db.pragma('writable_schema = OFF');
      }
      const row = db.prepare<[], { sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mission_criteria'`).get();
      if (!(row?.sql ?? '').includes(NEW_SOURCES)) {
        throw new TandemiseError('INTERNAL', 'Migration 024 did not widen the mission_criteria source constraint; implicit criteria would be rejected.', {
          details: { schema: row?.sql ?? null },
        });
      }
      const version = db.pragma('schema_version', { simple: true }) as number;
      db.pragma(`schema_version = ${version + 1}`);
    } finally {
      db.unsafeMode(false);
    }
  },
};
