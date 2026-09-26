import type { Migration } from './types.js';

/**
 * The Done-when ledger (P5 spec §7).
 *
 * One row per criterion: the person's Done-when lines (`source = 'user'`,
 * keys `U1…`) and the newest ProductSpec's acceptance criteria
 * (`source = 'spec'`, the spec's own ids). Results are never stored; they are
 * read from the newest QA evaluation whenever they are asked for.
 *
 * A newer spec supersedes the previous spec's rows rather than deleting them,
 * so what a spec once promised stays on record. Keys are therefore unique only
 * among live rows - the partial index - because a revised spec reuses `AC1`.
 *
 * `position` keeps the order the person and the spec wrote them in: rows
 * written in one batch share a `created_at`.
 *
 * Nothing is backfilled. Missions already in flight were planned with gates
 * that read the old facts, and a ledger appearing under them would change what
 * those gates measure halfway through.
 */
export const migration011: Migration = {
  version: 11,
  name: 'mission_criteria',
  up: `
CREATE TABLE mission_criteria (
  id               TEXT PRIMARY KEY,
  mission_id       TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  key              TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 40),
  statement        TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 2000),
  source           TEXT NOT NULL CHECK (source IN ('user','spec')),
  covers           TEXT NOT NULL DEFAULT '[]',
  spec_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  position         INTEGER NOT NULL DEFAULT 0,
  superseded_at    TEXT,
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_mission_criteria_live_key ON mission_criteria (mission_id, key) WHERE superseded_at IS NULL;
CREATE INDEX ix_mission_criteria_mission ON mission_criteria (mission_id, source, position);
`,
};
