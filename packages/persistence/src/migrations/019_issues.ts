import type { Migration } from './types.js';

/**
 * GitHub issues in and out (P14 spec §3).
 *
 * Additive only:
 *
 *  - `issue_sync` holds a repository's opt-in and its settings, one row per
 *    repository that ever had them (no row = never switched on).
 *  - `issue_links` is one row per issue read, unique per repository and
 *    number: the dedupe a second check, a second tick or a restart relies on.
 *    It is written before its mission (`pending`), and the mission carries
 *    `issue_link_id`, so a restart between the two finds the mission instead
 *    of making another. The title and body are what was last read, so an
 *    upstream edit is a difference from them.
 *  - `issue_comments` is the comment Tandemise wrote per link and kind, with
 *    the body last written: write-back compares against it and updates that
 *    comment rather than posting a second one.
 */
export const migration019: Migration = {
  version: 19,
  name: 'issues',
  up: `
CREATE TABLE issue_sync (
  repository_id     TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled           INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  github_repo       TEXT,
  label             TEXT NOT NULL DEFAULT 'tandemise' CHECK (length(label) BETWEEN 1 AND 50),
  poll_minutes      INTEGER NOT NULL DEFAULT 10 CHECK (poll_minutes BETWEEN 1 AND 1440),
  close_on_complete INTEGER NOT NULL DEFAULT 0 CHECK (close_on_complete IN (0,1)),
  post_comments     INTEGER NOT NULL DEFAULT 1 CHECK (post_comments IN (0,1)),
  workflow_preset   TEXT,
  enabled_by        TEXT,
  last_checked_at   TEXT,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE TABLE issue_links (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id       TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  github_repo         TEXT NOT NULL,
  issue_number        INTEGER NOT NULL CHECK (issue_number >= 1),
  url                 TEXT NOT NULL,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL DEFAULT '',
  author              TEXT,
  upstream_updated_at TEXT,
  state               TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed','unlabelled')),
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','linked')),
  criteria_count      INTEGER NOT NULL DEFAULT 0,
  stall_open          INTEGER NOT NULL DEFAULT 0 CHECK (stall_open IN (0,1)),
  closed_by_us_at     TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (repository_id, issue_number)
);
CREATE INDEX ix_issue_links_workspace ON issue_links(workspace_id, issue_number);
CREATE TABLE issue_comments (
  link_id    TEXT NOT NULL REFERENCES issue_links(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('queued','completed','blocked')),
  comment_id TEXT NOT NULL,
  body       TEXT NOT NULL,
  posted_at  TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (link_id, kind)
);
ALTER TABLE missions ADD COLUMN issue_link_id TEXT REFERENCES issue_links(id) ON DELETE SET NULL;
CREATE INDEX ix_missions_issue_link ON missions(issue_link_id);
`,
};
