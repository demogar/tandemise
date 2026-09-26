import { TandemiseError } from '@tandemise/shared';
import type { SqliteHandle } from '../database.js';
import type { Migration } from './types.js';

/**
 * Ready before planning (P6 spec §4), and room for P10's status report.
 *
 * Three changes:
 *
 *  1. `artifacts.type` accepts `Refinement` and `StatusReport`. Migration 001
 *     wrote the artifact types into a CHECK, so a new type is a schema edit.
 *     Both are widened here, together, so the table is touched once.
 *  2. `mission_criteria` learns where a criterion stands. A refinement's
 *     proposals wait as `proposed` until the person decides them; only
 *     `accepted` rows are the ledger every gate reads. Existing rows are the
 *     person's lines and spec criteria, which are accepted by definition, so
 *     the default leaves their meaning untouched.
 *  3. `mission_questions` holds what a refinement asked and what the person
 *     answered.
 *
 * Why the artifacts CHECK is edited in place rather than the table rebuilt
 * -----------------------------------------------------------------------
 * `artifacts` is referenced by `artifact_links`, `run_inputs` and `feedback`
 * (cascade or set-null), by itself (`supersedes`, `superseded_by`), carries a
 * generated column (`handoff_text`) and an external-content FTS index with
 * three triggers. The create/copy/drop/rename dance under `foreign_keys = ON`
 * would cascade every link and run input away and has to rebuild the index.
 * Migration 006 established the conservative alternative: rewrite only the
 * list of strings inside the CHECK in `sqlite_master`, which leaves the
 * on-disk format identical, then bump `schema_version` so every connection
 * re-reads the schema, and assert the post-condition rather than trust a
 * `replace()` that can silently match nothing.
 */

/** Read as a diff: this is the whole change to the artifacts table. */
const OLD_TYPES = `'Evidence','MissionPlan'))`;
const NEW_TYPES = `'Evidence','MissionPlan','Refinement','StatusReport'))`;
const ADDED = ['Refinement', 'StatusReport'] as const;

export const migration012: Migration = {
  version: 12,
  name: 'ready_before_planning',
  up: `
ALTER TABLE mission_criteria ADD COLUMN status TEXT NOT NULL DEFAULT 'accepted'
  CHECK (status IN ('proposed','accepted','rejected','stale'));
ALTER TABLE mission_criteria ADD COLUMN refinement_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL;
ALTER TABLE mission_criteria ADD COLUMN decided_by TEXT;
ALTER TABLE mission_criteria ADD COLUMN decided_at TEXT;
CREATE INDEX ix_mission_criteria_status ON mission_criteria (mission_id, status);

CREATE TABLE mission_questions (
  id                     TEXT PRIMARY KEY,
  mission_id             TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  key                    TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 40),
  text                   TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  why                    TEXT NOT NULL DEFAULT '',
  options                TEXT NOT NULL DEFAULT '[]',
  answer                 TEXT CHECK (answer IS NULL OR length(answer) BETWEEN 1 AND 4000),
  answered_by            TEXT,
  status                 TEXT NOT NULL CHECK (status IN ('open','answered','stale')),
  refinement_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  position               INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  answered_at            TEXT,
  UNIQUE (mission_id, key)
);
CREATE INDEX ix_mission_questions_mission ON mission_questions (mission_id, status, position);
`,
  transform: (db: SqliteHandle): void => {
    db.unsafeMode(true);
    try {
      db.pragma('writable_schema = ON');
      try {
        db.prepare(
          `UPDATE sqlite_master SET sql = replace(sql, :old, :new) WHERE type = 'table' AND name = 'artifacts'`,
        ).run({ old: OLD_TYPES, new: NEW_TYPES });
      } finally {
        // Left on, any later statement in this process could rewrite the schema.
        db.pragma('writable_schema = OFF');
      }
      const row = db
        .prepare<[], { sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'`)
        .get();
      const missing = ADDED.filter((type) => !(row?.sql ?? '').includes(`'${type}'`));
      if (missing.length > 0) {
        throw new TandemiseError(
          'INTERNAL',
          `Migration 012 did not widen the artifacts type constraint; ${missing.join(', ')} would still be rejected.`,
          { details: { schema: row?.sql ?? null } },
        );
      }
      // Without this bump every open connection keeps the old constraint cached
      // (see migration 006): the migration would appear to succeed and the
      // first Refinement would still fail the CHECK.
      const version = db.pragma('schema_version', { simple: true }) as number;
      db.pragma(`schema_version = ${version + 1}`);
    } finally {
      db.unsafeMode(false);
    }
  },
};
