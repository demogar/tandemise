import type { Migration } from './types.js';

/**
 * Intake into the primary tracker (spec 2026-10-30-intake-design.md, plan
 * Task 2). Numbered 022, the next free number on its base (RULINGS.md
 * Ruling 1); it depends on nothing from hold-and-interact or the brain.
 *
 * Additive only. Everything is keyed so a repeat, a second daemon tick or a
 * restart finds what is already there:
 *
 *  - `intake_sources` is a source's running state per project (enabled, the
 *    runner's cursor, its last check). Its configuration is not here: that is
 *    read through `IntakeConfigSource`.
 *  - `intake_tokens` holds push tokens by sha256 only.
 *  - `intake_signals` is one row per `(workspace, fingerprint)`: a repeat adds
 *    an occurrence instead of a row.
 *  - `intake_attachments` keeps a blob hash or a link, never both.
 *  - `tracker_items` is the board cache. `written_state` is the state
 *    Tandemise last wrote, so write-back never overrides a person's change.
 *  - `intake_links` is one row per signal, written `pending` before the
 *    tracker call (the ref is null until a create returns) and `done` after.
 *    `written` is what Tandemise last wrote to the tracker for it (level,
 *    events), the bar for a change that matters (plan Task 7).
 *  - `intake_closures` is one row per `(signal, kind)`: exactly-once closure.
 *  - `tracker_comments` is the one comment per `(item, marker)`, as P14's
 *    `issue_comments`.
 *  - `intake_webhook_inbox` is what the opt-in listener received, claimed by
 *    the runners that read it.
 *
 * `missions.tracker_item_id` is an ALTER ADD COLUMN, never a rebuild: a
 * rebuild cascade-deletes under foreign keys. Forgetting a cached item leaves
 * its mission running, unlinked.
 */
export const migration022: Migration = {
  version: 22,
  name: 'intake',
  up: `
CREATE TABLE intake_sources (
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  enabled_by      TEXT,
  cursor          TEXT,
  last_checked_at TEXT,
  last_error      TEXT,
  secret_refs     TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, source_id)
);
CREATE TABLE intake_tokens (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id    TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX ix_intake_tokens_workspace ON intake_tokens(workspace_id);
CREATE TABLE intake_signals (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id     TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT '',
  instance      TEXT NOT NULL DEFAULT '',
  key           TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  reporter      TEXT,
  impact        TEXT,
  labels        TEXT NOT NULL DEFAULT '[]',
  reply         TEXT,
  kind_hint     TEXT CHECK (kind_hint IS NULL OR kind_hint IN ('bug','request','question')),
  occurrences   INTEGER NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('received','held_back','needs_decision','linked','created','rejected',
                                                'dismissed','closure_pending','closed','closure_failed')),
  reason        TEXT,
  candidate_ref TEXT,
  score         REAL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (workspace_id, fingerprint)
);
CREATE INDEX ix_intake_signals_status ON intake_signals(workspace_id, status);
CREATE TABLE intake_attachments (
  signal_id   TEXT NOT NULL REFERENCES intake_signals(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  media_type  TEXT NOT NULL,
  blob_sha256 TEXT,
  url         TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK ((blob_sha256 IS NULL) <> (url IS NULL))
);
CREATE INDEX ix_intake_attachments_signal ON intake_attachments(signal_id);
CREATE TABLE tracker_items (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_ref            TEXT NOT NULL,
  key                 TEXT NOT NULL,
  url                 TEXT NOT NULL,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  state               TEXT NOT NULL,
  assignee            TEXT,
  type                TEXT,
  upstream_created_at TEXT NOT NULL,
  upstream_updated_at TEXT NOT NULL,
  written_state       TEXT,
  refreshed_at        TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (workspace_id, item_ref)
);
CREATE INDEX ix_tracker_items_key ON tracker_items(workspace_id, key);
CREATE TABLE intake_links (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  signal_id    TEXT NOT NULL UNIQUE REFERENCES intake_signals(id) ON DELETE CASCADE,
  item_ref     TEXT,
  status       TEXT NOT NULL CHECK (status IN ('pending','done')),
  linked_by    TEXT NOT NULL CHECK (linked_by IN ('created','url','source_is_item','similarity','person','merged')),
  score        REAL,
  written      TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX ix_intake_links_item ON intake_links(workspace_id, item_ref);
CREATE TABLE intake_closures (
  id              TEXT PRIMARY KEY,
  signal_id       TEXT NOT NULL REFERENCES intake_signals(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('done','not_planned')),
  state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','closed','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  external_id     TEXT,
  last_error      TEXT,
  closed_at       TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (signal_id, kind)
);
CREATE INDEX ix_intake_closures_due ON intake_closures(state, next_attempt_at);
CREATE TABLE tracker_comments (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_ref     TEXT NOT NULL,
  marker       TEXT NOT NULL CHECK (marker IN ('tandemise:sources','tandemise:activity')),
  comment_id   TEXT NOT NULL,
  body         TEXT NOT NULL,
  posted_at    TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, item_ref, marker)
);
CREATE TABLE intake_webhook_inbox (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL,
  received_at TEXT NOT NULL,
  headers     TEXT NOT NULL DEFAULT '{}',
  body        BLOB NOT NULL,
  claimed_at  TEXT,
  done_at     TEXT
);
CREATE INDEX ix_intake_webhook_inbox_open ON intake_webhook_inbox(done_at, claimed_at, received_at);
ALTER TABLE missions ADD COLUMN tracker_item_id TEXT REFERENCES tracker_items(id) ON DELETE SET NULL;
CREATE INDEX ix_missions_tracker_item ON missions(tracker_item_id);
`,
};
