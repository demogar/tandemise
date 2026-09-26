import type { Migration } from './types.js';

/**
 * The skills library (P13 spec §6).
 *
 * Additive only:
 *
 *  - `skills` is a project's library entry, unique by name per project.
 *  - `skill_versions` are immutable snapshots, each naming its content hash;
 *    the files live in the content store (`<home>/skills/<hash>/`), shared by
 *    every project, so the index on `hash` answers "does anyone still use it".
 *  - `role_templates.skills` pins skills to a role at a version.
 *  - `mission_tasks.skills` is what a task's runs get, resolved when the task
 *    was created; NULL means not resolved yet.
 *  - `runs.skills` records what each run received and how; NULL before P13.
 */
export const migration018: Migration = {
  version: 18,
  name: 'skills',
  up: `
CREATE TABLE skills (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);
CREATE TABLE skill_versions (
  id          TEXT PRIMARY KEY,
  skill_id    TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL CHECK (version >= 1),
  hash        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  files       TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (skill_id, version)
);
CREATE INDEX ix_skill_versions_hash ON skill_versions(hash);
ALTER TABLE role_templates ADD COLUMN skills TEXT;
ALTER TABLE mission_tasks ADD COLUMN skills TEXT;
ALTER TABLE runs ADD COLUMN skills TEXT;
`,
};
