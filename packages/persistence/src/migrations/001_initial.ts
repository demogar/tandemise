import type { Migration } from './types.js';

/**
 * The initial schema (MVP.md §20.2).
 *
 * Conventions this file establishes and every later migration must keep:
 *
 *  - Ids are TEXT (`ids.*()` produces lexicographically time-sortable strings),
 *    so `ORDER BY id` is already chronological and no surrogate key is needed.
 *  - Timestamps are ISO-8601 UTC TEXT as produced by `Date#toISOString`. That
 *    format is fixed-width, so string comparison *is* chronological comparison -
 *    which is what lets lease expiry and event windows be plain `<`/`>`.
 *  - Booleans are INTEGER 0/1 with a CHECK, because SQLite has no boolean type.
 *  - Status/enum columns carry CHECK constraints mirroring the domain unions.
 *    The domain is the source of truth; the CHECK is the backstop that stops a
 *    typo in a repository from silently poisoning the scheduler's queries.
 *  - Payload with no relational shape (settings, evidence, findings) is JSON in
 *    a TEXT column. Anything a query filters, joins or orders by is a real
 *    column - never a `json_extract`.
 */
export const migration001: Migration = {
  version: 1,
  name: 'initial',
  up: `
-- ---------------------------------------------------------------- workspaces

CREATE TABLE workspaces (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  -- ON DELETE SET NULL, not CASCADE: removing the default repository must not
  -- take the workspace with it.
  default_repository_id  TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  autonomy               TEXT NOT NULL,
  concurrency            TEXT NOT NULL,
  routing                TEXT NOT NULL,
  default_autonomy_level TEXT NOT NULL CHECK (default_autonomy_level IN ('supervised','balanced','autonomous')),
  knowledge              TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE repositories (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  path           TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  remote_url     TEXT,
  checks         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX ix_repositories_workspace ON repositories (workspace_id);

-- ------------------------------------------------------------------ missions

CREATE TABLE missions (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id      TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  title              TEXT NOT NULL,
  goal               TEXT NOT NULL,
  constraints        TEXT NOT NULL,
  success_criteria   TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN (
                       'DRAFT','PLANNING','AWAITING_PLAN_APPROVAL','EXECUTING','REVIEWING',
                       'QA','READY_TO_SHIP','RELEASED','OBSERVING','COMPLETE',
                       'BLOCKED','PAUSED','FAILED','CANCELLED')),
  autonomy           TEXT NOT NULL CHECK (autonomy IN ('supervised','balanced','autonomous')),
  workflow_preset    TEXT NOT NULL,
  integration_branch TEXT,
  base_branch        TEXT,
  status_reason      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  started_at         TEXT,
  completed_at       TEXT
);
CREATE INDEX ix_missions_workspace_status ON missions (workspace_id, status);
CREATE INDEX ix_missions_status          ON missions (status);
CREATE INDEX ix_missions_repository      ON missions (repository_id);

CREATE TABLE mission_tasks (
  id                    TEXT PRIMARY KEY,
  mission_id            TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  key                   TEXT NOT NULL,
  title                 TEXT NOT NULL,
  objective             TEXT NOT NULL,
  role_id               TEXT NOT NULL,
  required_capabilities TEXT NOT NULL,
  input_artifacts       TEXT NOT NULL,
  expected_outputs      TEXT NOT NULL,
  execution_policy      TEXT NOT NULL,
  approval_policy       TEXT NOT NULL,
  retry_policy          TEXT NOT NULL,
  completion_gate       TEXT,
  status                TEXT NOT NULL CHECK (status IN (
                          'PENDING','READY','RUNNING','AWAITING_APPROVAL','BLOCKED',
                          'SUCCEEDED','FAILED','SKIPPED','CANCELLED')),
  status_reason         TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0,
  -- SET NULL rather than CASCADE: a remediation task stays meaningful once the
  -- task it was fixing has been replanned away.
  remediates_task_id    TEXT REFERENCES mission_tasks(id) ON DELETE SET NULL,
  order_hint            INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  started_at            TEXT,
  finished_at           TEXT,
  UNIQUE (mission_id, key)
);
CREATE INDEX ix_mission_tasks_mission_order ON mission_tasks (mission_id, order_hint);
CREATE INDEX ix_mission_tasks_status        ON mission_tasks (status);
CREATE INDEX ix_mission_tasks_role          ON mission_tasks (role_id);

-- Dependencies are stored by *key*, not by task id, because a plan is authored
-- against keys and may be re-planned wholesale: keys survive a replaceAll, ids
-- do not.
CREATE TABLE task_dependencies (
  task_id        TEXT NOT NULL REFERENCES mission_tasks(id) ON DELETE CASCADE,
  depends_on_key TEXT NOT NULL,
  ordinal        INTEGER NOT NULL,
  PRIMARY KEY (task_id, depends_on_key)
);
CREATE INDEX ix_task_dependencies_key ON task_dependencies (depends_on_key);

-- -------------------------------------------------------------- organization

-- A role id is unique *within its scope*: a workspace may override a built-in
-- role by storing a row with the same id and its own workspace_id. SQLite
-- treats NULLs as distinct in a UNIQUE index, so the scope key is coalesced.
CREATE TABLE role_templates (
  id                   TEXT NOT NULL,
  workspace_id         TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  summary              TEXT NOT NULL,
  instructions         TEXT NOT NULL,
  default_capabilities TEXT NOT NULL,
  produces_artifacts   TEXT NOT NULL,
  consumes_artifacts   TEXT NOT NULL,
  default_isolation    TEXT NOT NULL CHECK (default_isolation IN ('none','worktree','docker','browser')),
  output_contract      TEXT NOT NULL,
  built_in             INTEGER NOT NULL CHECK (built_in IN (0,1)),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_role_templates_scope ON role_templates (id, ifnull(workspace_id, ''));
CREATE INDEX ix_role_templates_workspace ON role_templates (workspace_id);

CREATE TABLE runtime_profiles (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  adapter_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  executable_path TEXT,
  args            TEXT NOT NULL,
  settings        TEXT NOT NULL,
  capabilities    TEXT NOT NULL,
  enabled         INTEGER NOT NULL CHECK (enabled IN (0,1)),
  max_concurrent  INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX ix_runtime_profiles_workspace ON runtime_profiles (workspace_id);
CREATE INDEX ix_runtime_profiles_adapter   ON runtime_profiles (adapter_id);

CREATE TABLE execution_targets (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id        TEXT REFERENCES missions(id) ON DELETE CASCADE,
  task_id           TEXT REFERENCES mission_tasks(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('local','worktree','docker','browser','remote')),
  name              TEXT NOT NULL,
  working_directory TEXT NOT NULL,
  branch            TEXT,
  base_branch       TEXT,
  status            TEXT NOT NULL CHECK (status IN ('PROVISIONING','READY','IN_USE','RELEASED','FAILED')),
  detail            TEXT,
  created_at        TEXT NOT NULL,
  released_at       TEXT
);
CREATE INDEX ix_execution_targets_mission ON execution_targets (mission_id);
CREATE INDEX ix_execution_targets_status  ON execution_targets (status);

CREATE TABLE integrations (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id    TEXT NOT NULL,
  name           TEXT NOT NULL,
  transport      TEXT NOT NULL CHECK (transport IN ('cli','rest','mcp','browser','desktop','builtin')),
  config         TEXT NOT NULL,
  -- A handle into the OS credential store, never a secret (MVP.md §P8).
  credential_ref TEXT,
  enabled        INTEGER NOT NULL CHECK (enabled IN (0,1)),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX ix_integrations_workspace ON integrations (workspace_id);

-- Normalized so "which integration can do github.pr.create?" is an index scan
-- rather than a JSON walk over every row.
CREATE TABLE integration_grants (
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  capability     TEXT NOT NULL,
  ordinal        INTEGER NOT NULL,
  PRIMARY KEY (integration_id, capability)
);
CREATE INDEX ix_integration_grants_capability ON integration_grants (capability);

-- --------------------------------------------------------------------- work

-- runtime_profile_id and execution_target_id are intentionally *not* foreign
-- keys: an assignment is a historical record of what ran, and must survive the
-- profile being deleted or the target being torn down.
CREATE TABLE worker_assignments (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id          TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id             TEXT NOT NULL REFERENCES mission_tasks(id) ON DELETE CASCADE,
  role_id             TEXT NOT NULL,
  runtime_profile_id  TEXT NOT NULL,
  execution_target_id TEXT NOT NULL,
  grants              TEXT NOT NULL,
  budgets             TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX ix_worker_assignments_task    ON worker_assignments (task_id);
CREATE INDEX ix_worker_assignments_mission ON worker_assignments (mission_id);

CREATE TABLE runs (
  id                  TEXT PRIMARY KEY,
  mission_id          TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id             TEXT NOT NULL REFERENCES mission_tasks(id) ON DELETE CASCADE,
  assignment_id       TEXT NOT NULL REFERENCES worker_assignments(id) ON DELETE CASCADE,
  attempt             INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN (
                        'STARTING','RUNNING','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED','RESUMABLE')),
  role_id             TEXT NOT NULL,
  runtime_profile_id  TEXT NOT NULL,
  execution_target_id TEXT NOT NULL,
  -- An opaque runtime session handle, never a credential (MVP.md §10.3).
  external_session_id TEXT,
  pid                 INTEGER,
  exit_code           INTEGER,
  error_code          TEXT,
  error_message       TEXT,
  usage               TEXT,
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  heartbeat_at        TEXT,
  UNIQUE (task_id, attempt)
);
CREATE INDEX ix_runs_mission   ON runs (mission_id);
CREATE INDEX ix_runs_status    ON runs (status);
CREATE INDEX ix_runs_heartbeat ON runs (status, heartbeat_at);

-- Append-only usage history. runs.usage holds the latest snapshot for the run
-- detail view; this table is what cost/usage reporting aggregates over time,
-- and keeping it separate means a corrected late report does not erase the
-- earlier observation (MVP.md §22.2).
CREATE TABLE usage_records (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  mission_id         TEXT NOT NULL,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  cost_usd           REAL,
  wall_time_ms       INTEGER,
  turns              INTEGER,
  recorded_at        TEXT NOT NULL
);
CREATE INDEX ix_usage_records_run     ON usage_records (run_id);
CREATE INDEX ix_usage_records_mission ON usage_records (mission_id, recorded_at);

CREATE TABLE checkpoints (
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence            INTEGER NOT NULL,
  label               TEXT NOT NULL,
  external_session_id TEXT,
  payload             TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence)
);

-- ----------------------------------------------------------------- event log

-- task_id / run_id are deliberately un-constrained: the log is append-only
-- audit (MVP.md §20.3) and must not be rewritten when a replan deletes the task
-- rows it happens to mention. It still cascades with its mission, because a
-- deleted mission has no timeline to reconstruct.
CREATE TABLE run_events (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL,
  mission_id         TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id            TEXT,
  run_id             TEXT,
  sequence           INTEGER NOT NULL,
  type               TEXT NOT NULL,
  role_id            TEXT,
  runtime_profile_id TEXT,
  body               TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  -- Also the index that makes the per-mission sequence assignment a single
  -- index lookup rather than a table scan.
  UNIQUE (mission_id, sequence)
);
CREATE INDEX ix_run_events_run  ON run_events (run_id, sequence);
CREATE INDEX ix_run_events_type ON run_events (mission_id, type, sequence);

-- ----------------------------------------------------------------- artifacts

CREATE TABLE artifacts (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id       TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id          TEXT,
  created_by_run_id TEXT,
  type             TEXT NOT NULL CHECK (type IN (
                     'ProblemBrief','ProductSpec','DesignBrief','ArchitecturePlan','ImplementationPlan',
                     'ChangeSet','ReviewReport','QAPlan','QAReport','ReleaseCandidate',
                     'DecisionRecord','FinanceReport','Evidence','MissionPlan')),
  title            TEXT NOT NULL,
  content_ref      TEXT NOT NULL,
  media_type       TEXT NOT NULL,
  sha256           TEXT NOT NULL,
  byte_size        INTEGER NOT NULL,
  schema_version   INTEGER NOT NULL,
  supersedes       TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  -- Denormalized back-pointer so "latest live artifact of type T" is one
  -- indexed lookup; artifacts are read far more often than they are superseded.
  superseded_by    TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  summary          TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX ix_artifacts_mission_type ON artifacts (mission_id, type, superseded_by, created_at);
CREATE INDEX ix_artifacts_task         ON artifacts (task_id);
CREATE INDEX ix_artifacts_workspace    ON artifacts (workspace_id, created_at);
CREATE INDEX ix_artifacts_sha          ON artifacts (sha256);

-- An artifact's pointers into systems that own the real truth - a commit, a PR,
-- a file (MVP.md §15.3). Normalized so "what did we produce for PR #42?" is an
-- index lookup.
CREATE TABLE artifact_links (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('git.commit','git.branch','github.pr','github.issue','url','file')),
  value       TEXT NOT NULL,
  label       TEXT,
  PRIMARY KEY (artifact_id, ordinal)
);
CREATE INDEX ix_artifact_links_target ON artifact_links (kind, value);

-- Full-text index over the human-readable parts of the manifest. External
-- content: the index stores only terms, the rows stay in artifacts.
CREATE VIRTUAL TABLE artifacts_fts USING fts5 (
  title,
  summary,
  content='artifacts',
  content_rowid='rowid'
);

CREATE TRIGGER artifacts_fts_ai AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts (rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
END;
CREATE TRIGGER artifacts_fts_ad AFTER DELETE ON artifacts BEGIN
  INSERT INTO artifacts_fts (artifacts_fts, rowid, title, summary) VALUES ('delete', old.rowid, old.title, old.summary);
END;
CREATE TRIGGER artifacts_fts_au AFTER UPDATE ON artifacts BEGIN
  INSERT INTO artifacts_fts (artifacts_fts, rowid, title, summary) VALUES ('delete', old.rowid, old.title, old.summary);
  INSERT INTO artifacts_fts (rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
END;

-- ------------------------------------------------------- decisions/approvals

CREATE TABLE decisions (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id        TEXT REFERENCES missions(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  context           TEXT NOT NULL,
  decision          TEXT NOT NULL,
  rationale         TEXT NOT NULL,
  alternatives      TEXT NOT NULL,
  consequences      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected','superseded')),
  owner             TEXT NOT NULL,
  related_artifacts TEXT NOT NULL,
  supersedes        TEXT REFERENCES decisions(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  decided_at        TEXT
);
CREATE INDEX ix_decisions_mission   ON decisions (mission_id, created_at);
CREATE INDEX ix_decisions_workspace ON decisions (workspace_id, status);

CREATE TABLE approvals (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id            TEXT REFERENCES missions(id) ON DELETE CASCADE,
  task_id               TEXT,
  run_id                TEXT,
  kind                  TEXT NOT NULL CHECK (kind IN ('plan','choice','exception','action','release','intervention')),
  status                TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED')),
  risk                  TEXT NOT NULL CHECK (risk IN (
                          'read','write_reversible','external_side_effect','destructive','financial','release')),
  title                 TEXT NOT NULL,
  rationale             TEXT NOT NULL,
  effect                TEXT NOT NULL,
  evidence              TEXT NOT NULL,
  options               TEXT NOT NULL,
  recommended_option_id TEXT,
  selected_option_id    TEXT,
  decided_by            TEXT,
  decision_note         TEXT,
  created_at            TEXT NOT NULL,
  decided_at            TEXT,
  expires_at            TEXT
);
CREATE INDEX ix_approvals_mission_status   ON approvals (mission_id, status);
CREATE INDEX ix_approvals_workspace_status ON approvals (workspace_id, status);
CREATE INDEX ix_approvals_task_status      ON approvals (task_id, status);
CREATE INDEX ix_approvals_expiry           ON approvals (status, expires_at);

-- Reserved by MVP.md §20.2. @tandemise/policy owns the shape of definition;
-- this table deliberately knows only what every policy store needs - scope,
-- ordering, and an on/off switch - so the rule language can evolve without a
-- schema change.
CREATE TABLE policies (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  enabled      INTEGER NOT NULL CHECK (enabled IN (0,1)),
  priority     INTEGER NOT NULL DEFAULT 0,
  definition   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX ix_policies_workspace ON policies (workspace_id, enabled, priority);

-- ---------------------------------------------------------------- evaluation

CREATE TABLE evaluations (
  id                TEXT PRIMARY KEY,
  mission_id        TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id           TEXT NOT NULL REFERENCES mission_tasks(id) ON DELETE CASCADE,
  run_id            TEXT,
  evaluator_role_id TEXT NOT NULL,
  verdict           TEXT NOT NULL CHECK (verdict IN ('pass','fail','needs_changes')),
  summary           TEXT NOT NULL,
  findings          TEXT NOT NULL,
  criteria_coverage TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX ix_evaluations_task    ON evaluations (task_id, created_at);
CREATE INDEX ix_evaluations_mission ON evaluations (mission_id, created_at);

CREATE TABLE check_results (
  id          TEXT PRIMARY KEY,
  mission_id  TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id     TEXT NOT NULL REFERENCES mission_tasks(id) ON DELETE CASCADE,
  run_id      TEXT,
  name        TEXT NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('PASS','FAIL','SKIP')),
  detail      TEXT NOT NULL,
  command     TEXT,
  exit_code   INTEGER,
  duration_ms INTEGER NOT NULL,
  output_ref  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX ix_check_results_task    ON check_results (task_id, name, created_at);
CREATE INDEX ix_check_results_mission ON check_results (mission_id, created_at);

-- -------------------------------------------------------------------- leases

-- The UNIQUE on resource_key is the whole concurrency control: acquisition is
-- an upsert that only fires when the incumbent lease has expired, so two
-- daemons (or two scheduler ticks) racing for the same branch cannot both win.
-- holder_run_id is not a foreign key on purpose - a lease outliving its run is
-- exactly the stale-lease case startup recovery must be able to see and clean
-- up (MVP.md §21.2).
CREATE TABLE resource_leases (
  id             TEXT PRIMARY KEY,
  resource_key   TEXT NOT NULL UNIQUE,
  holder_run_id  TEXT,
  holder_task_id TEXT,
  acquired_at    TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  heartbeat_at   TEXT NOT NULL
);
CREATE INDEX ix_resource_leases_expires ON resource_leases (expires_at);
CREATE INDEX ix_resource_leases_run     ON resource_leases (holder_run_id);
`,
};
