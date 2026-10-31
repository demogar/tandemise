/**
 * The coordination schema (spec §Data model). The same DDL runs in a relay's
 * own database and in each daemon's database, so "the same shape" means the
 * same text. Every table is prefixed `coord_` so it can live inside the
 * daemon's database without colliding.
 *
 * There are no foreign keys on purpose: a daemon's mirror holds only part of a
 * relay's data (its own devices, active claims), and must be able to store a
 * claim whose device it has never seen.
 */
export const COORD_DDL_V1 = `
CREATE TABLE coord_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE coord_members (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  handles      TEXT NOT NULL DEFAULT '{}',
  role         TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE coord_devices (
  id           TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL,
  label        TEXT NOT NULL,
  token_hash   TEXT UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at   TEXT
);

CREATE TABLE coord_invites (
  id           TEXT PRIMARY KEY,
  code_hash    TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  display_name TEXT NOT NULL,
  member_id    TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  redeemed_at  TEXT,
  redeemed_by  TEXT
);

CREATE TABLE coord_claims (
  id           TEXT PRIMARY KEY,
  project_key  TEXT NOT NULL,
  item_ref     TEXT NOT NULL,
  item_title   TEXT NOT NULL,
  item_url     TEXT,
  member_id    TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  local_ref    TEXT,
  state        TEXT NOT NULL CHECK (state IN ('active', 'ended')),
  ended_reason TEXT CHECK (ended_reason IN ('done', 'released', 'taken_over', 'removed')),
  ended_by     TEXT,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  seq          INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_coord_claims_active ON coord_claims (project_key, item_ref) WHERE state = 'active';
CREATE INDEX idx_coord_claims_item ON coord_claims (project_key, item_ref, started_at);
CREATE INDEX idx_coord_claims_local_ref ON coord_claims (local_ref);

CREATE TABLE coord_presence (
  device_id    TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('online', 'away')),
  last_seen_at TEXT NOT NULL
);

CREATE TABLE coord_endpoints (
  id               TEXT PRIMARY KEY,
  project_key      TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  source           TEXT NOT NULL,
  handshake        TEXT NOT NULL CHECK (handshake IN ('none', 'meta_hub', 'echo_challenge')),
  handshake_secret TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  disabled_at      TEXT,
  dropped_count    INTEGER NOT NULL DEFAULT 0,
  drop_flag        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE coord_mailbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id  TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  method       TEXT NOT NULL,
  query        TEXT NOT NULL DEFAULT '',
  headers      TEXT NOT NULL DEFAULT '{}',
  content_type TEXT,
  body         BLOB,
  body_bytes   INTEGER NOT NULL,
  lease_device TEXT,
  lease_until  TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  acked_at     TEXT,
  acked_by     TEXT,
  parked_at    TEXT
);

CREATE INDEX idx_coord_mailbox_endpoint ON coord_mailbox (endpoint_id, id);
`;

/** The tables a relay and a daemon share, byte for byte. */
export const COORD_SHARED_TABLES = [
  'coord_meta', 'coord_members', 'coord_devices', 'coord_invites',
  'coord_claims', 'coord_presence', 'coord_endpoints', 'coord_mailbox',
] as const;
