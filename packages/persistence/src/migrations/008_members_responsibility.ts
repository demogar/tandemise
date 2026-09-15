import { userInfo } from 'node:os';
import { TandemiseError, newId } from '@tandemise/shared';
import type { SqliteHandle } from '../database.js';
import type { Migration } from './types.js';

/**
 * People, owned agents, and who did, answers for and recorded each piece of work.
 *
 * Until now every action was taken by an unnamed "user" and every run by a
 * runtime profile. That is enough for one person at one machine, and not enough
 * to say who a question should go to, who has to look at finished work, or who
 * a stuck approval escalates to. This migration adds the people and the team
 * tree, and an actor column on everything that records a decision or a result.
 *
 * The backfill keeps a solo installation behaving exactly as before:
 *
 *  - One local person is created and made owner of every workspace. The name
 *    comes from `TANDEMISE_OWNER_NAME` or the OS user; the daemon renames it
 *    from `git config user.name` at startup, because a migration must not run
 *    processes.
 *  - Each role's runtime routing becomes an agent member owned by that person,
 *    with the same ranked runtimes, and the workspace's staffing points the
 *    role at it. Dispatch therefore picks the same runtimes it did yesterday.
 *  - Approvals decided by "user", missions and artifacts are attributed to the
 *    owner. An artifact written by a run is authored by the agent for the
 *    run's role, or by the runtime when that run is gone.
 *
 * `approvals.kind` gains `check`, a non-blocking look at finished work. The
 * CHECK constraint is widened by editing the stored schema, as migration 006
 * does and for the same reasons: nothing is copied, no index or trigger is
 * rebuilt, and the on-disk format is unchanged.
 */

const OLD_APPROVAL_KINDS = `'release','intervention')`;
const NEW_APPROVAL_KINDS = `'release','intervention','check')`;

const LOCAL_OWNER_FALLBACK = 'Owner';

export const migration008: Migration = {
  version: 8,
  name: 'members_responsibility',
  up: `
CREATE TABLE people (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  handles      TEXT NOT NULL DEFAULT '{}',
  -- Always NULL until accounts exist; the seam a signed-in identity attaches to.
  account_id   TEXT,
  created_at   TEXT NOT NULL,
  removed_at   TEXT
);

CREATE TABLE members (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('person','agent')),
  person_id           TEXT REFERENCES people(id),
  name                TEXT NOT NULL,
  title               TEXT,
  reports_to          TEXT REFERENCES members(id) ON DELETE SET NULL,
  access              TEXT CHECK (access IS NULL OR access IN ('owner','admin','member','guest')),
  oversight           TEXT NOT NULL DEFAULT 'delegate_owns' CHECK (oversight IN ('delegate_owns','both_sign_off')),
  role_ids            TEXT NOT NULL DEFAULT '[]',
  runtime_profile_ids TEXT NOT NULL DEFAULT '[]',
  integration_ids     TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  -- An agent acts on its owner's authority, so it cannot exist without one.
  CHECK ((kind = 'person' AND person_id IS NOT NULL) OR (kind = 'agent' AND person_id IS NULL AND reports_to IS NOT NULL))
);
CREATE UNIQUE INDEX ux_members_person ON members (workspace_id, person_id) WHERE person_id IS NOT NULL;
CREATE INDEX ix_members_workspace ON members (workspace_id, status);

ALTER TABLE workspaces ADD COLUMN staffing TEXT NOT NULL DEFAULT '{}';
ALTER TABLE missions ADD COLUMN created_by TEXT;
ALTER TABLE missions ADD COLUMN staffing TEXT NOT NULL DEFAULT '{}';
ALTER TABLE mission_tasks ADD COLUMN staffing TEXT;
ALTER TABLE mission_tasks ADD COLUMN staffing_override TEXT;
ALTER TABLE mission_tasks ADD COLUMN assignee_id TEXT;
ALTER TABLE mission_tasks ADD COLUMN responsible_id TEXT;
ALTER TABLE mission_tasks ADD COLUMN needs_attention INTEGER NOT NULL DEFAULT 0;
ALTER TABLE artifacts ADD COLUMN author_id TEXT;
ALTER TABLE artifacts ADD COLUMN responsible_id TEXT;
ALTER TABLE artifacts ADD COLUMN recorded_by TEXT;
ALTER TABLE approvals ADD COLUMN addressees TEXT NOT NULL DEFAULT '[]';
ALTER TABLE approvals ADD COLUMN escalation_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE approvals ADD COLUMN escalate_at TEXT;
ALTER TABLE approvals ADD COLUMN recorded_by TEXT;
ALTER TABLE runs ADD COLUMN agent_member_id TEXT;
ALTER TABLE run_events ADD COLUMN actor_id TEXT;
CREATE INDEX ix_tasks_assignee ON mission_tasks (assignee_id, status);
CREATE INDEX ix_approvals_escalate ON approvals (status, escalate_at);
`,
  transform: (db: SqliteHandle): void => {
    widenApprovalKinds(db);
    backfill(db);
  },
};

/** Same technique and safeguards as migration 006; see its notes. */
function widenApprovalKinds(db: SqliteHandle): void {
  db.unsafeMode(true);
  try {
    db.pragma('writable_schema = ON');
    try {
      db.prepare(
        `UPDATE sqlite_master
            SET sql = replace(sql, :old, :new)
          WHERE type = 'table' AND name = 'approvals'`,
      ).run({ old: OLD_APPROVAL_KINDS, new: NEW_APPROVAL_KINDS });
    } finally {
      db.pragma('writable_schema = OFF');
    }

    const row = db
      .prepare<[], { sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approvals'`)
      .get();
    if (!(row?.sql ?? '').includes(NEW_APPROVAL_KINDS)) {
      throw new TandemiseError(
        'INTERNAL',
        "Migration 008 did not widen the approvals kind constraint; 'check' would still be rejected.",
        { details: { schema: row?.sql ?? null } },
      );
    }

    // Without this bump the connection keeps enforcing the cached constraint.
    const version = db.pragma('schema_version', { simple: true }) as number;
    db.pragma(`schema_version = ${version + 1}`);
  } finally {
    db.unsafeMode(false);
  }
}

function backfill(db: SqliteHandle): void {
  const now = new Date().toISOString();
  const personId = localPerson(db, now);
  const displayName =
    db.prepare<[string], { display_name: string }>('SELECT display_name FROM people WHERE id = ?').get(personId)
      ?.display_name ?? LOCAL_OWNER_FALLBACK;

  const workspaces = db.prepare<[], { id: string; routing: string }>('SELECT id, routing FROM workspaces').all();
  const findOwner = db.prepare<[string], { id: string }>(
    `SELECT id FROM members WHERE workspace_id = ? AND kind = 'person' AND status = 'active'
     ORDER BY access = 'owner' DESC, created_at, id LIMIT 1`,
  );
  const insertMember = db.prepare(
    `INSERT INTO members (id, workspace_id, kind, person_id, name, title, reports_to, access, oversight,
                          role_ids, runtime_profile_ids, integration_ids, status, created_at, updated_at)
     VALUES (:id, :workspaceId, :kind, :personId, :name, NULL, :reportsTo, :access, 'delegate_owns',
             :roleIds, :runtimeProfileIds, '[]', 'active', :now, :now)`,
  );
  const countAgents = db.prepare<[string], { n: number }>(
    `SELECT count(*) AS n FROM members WHERE workspace_id = ? AND kind = 'agent'`,
  );
  const setStaffing = db.prepare('UPDATE workspaces SET staffing = ? WHERE id = ?');
  const attributeApprovals = db.prepare(
    `UPDATE approvals SET decided_by = :owner WHERE workspace_id = :workspaceId AND decided_by = 'user'`,
  );
  const attributeMissions = db.prepare(
    'UPDATE missions SET created_by = :owner WHERE workspace_id = :workspaceId AND created_by IS NULL',
  );
  // The agent for the run's role wrote it. A run that no longer resolves to
  // an agent was still a runtime's work, never a person's.
  const attributeArtifacts = db.prepare(
    `UPDATE artifacts SET
       responsible_id = :owner,
       author_id = COALESCE(
         (SELECT m.id FROM runs r
            JOIN members m ON m.workspace_id = artifacts.workspace_id AND m.kind = 'agent'
                          AND m.role_ids LIKE '%"' || r.role_id || '"%'
           WHERE r.id = artifacts.created_by_run_id
           ORDER BY m.created_at, m.id LIMIT 1),
         CASE WHEN artifacts.created_by_run_id IS NULL THEN NULL ELSE 'system:runtime' END)
     WHERE workspace_id = :workspaceId`,
  );

  for (const ws of workspaces) {
    let owner = findOwner.get(ws.id)?.id;
    if (owner === undefined) {
      owner = newId<'MemberId'>('mem');
      insertMember.run({
        id: owner, workspaceId: ws.id, kind: 'person', personId, name: displayName, reportsTo: null,
        access: 'owner', roleIds: '[]', runtimeProfileIds: '[]', now,
      });
    }

    if (countAgents.get(ws.id)?.n === 0) {
      const staffing: Record<string, { assignees: string[] }> = {};
      for (const [roleId, profiles] of Object.entries(parseRouting(ws.routing))) {
        if (profiles.length === 0) continue;
        const agentId = newId<'MemberId'>('mem');
        insertMember.run({
          id: agentId, workspaceId: ws.id, kind: 'agent', personId: null, name: agentName(roleId),
          reportsTo: owner, access: null, roleIds: JSON.stringify([roleId]),
          runtimeProfileIds: JSON.stringify(profiles), now,
        });
        staffing[roleId] = { assignees: [agentId] };
      }
      setStaffing.run(JSON.stringify(staffing), ws.id);
    }

    attributeApprovals.run({ owner, workspaceId: ws.id });
    attributeMissions.run({ owner, workspaceId: ws.id });
    attributeArtifacts.run({ owner, workspaceId: ws.id });
  }
}

/** The installation's first person, created if there is none yet. */
function localPerson(db: SqliteHandle, now: string): string {
  const existing = db
    .prepare<[], { id: string }>('SELECT id FROM people WHERE removed_at IS NULL ORDER BY created_at, id LIMIT 1')
    .get();
  if (existing) return existing.id;
  const id = newId<'PersonId'>('per');
  db.prepare(
    `INSERT INTO people (id, display_name, handles, account_id, created_at, removed_at)
     VALUES (?, ?, '{}', NULL, ?, NULL)`,
  ).run(id, ownerName(), now);
  return id;
}

function ownerName(): string {
  const fromEnv = process.env.TANDEMISE_OWNER_NAME?.trim();
  if (fromEnv) return fromEnv;
  // userInfo throws when the uid has no passwd entry, as in some containers.
  try {
    return userInfo().username || LOCAL_OWNER_FALLBACK;
  } catch {
    return LOCAL_OWNER_FALLBACK;
  }
}

/** A corrupt routing column must not stop the upgrade; it just yields no agents. */
function parseRouting(text: string): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [role, profiles] of Object.entries(parsed)) {
      if (Array.isArray(profiles)) out[role] = profiles.filter((p): p is string => typeof p === 'string');
    }
    return out;
  } catch {
    return {};
  }
}

function agentName(roleId: string): string {
  return `${roleId.charAt(0).toUpperCase()}${roleId.slice(1)} agent`;
}
