import { TandemiseError } from '@tandemise/shared';
import type { SqliteHandle } from '../database.js';
import type { Migration } from './types.js';

/**
 * A person taking the keyboard on an agent step (hold-and-interact spec).
 *
 * Two changes: `mission_tasks.status` learns `HELD`, and `task_holds` records
 * each hold. The status list is widened in place, exactly as migration 006
 * did and for the same reason: seven tables cascade from `mission_tasks`, so
 * rebuilding it would delete the execution history of every mission. See 006.
 */

const OLD_STATUSES = `'AWAITING_APPROVAL','BLOCKED'`;
const NEW_STATUSES = `'AWAITING_APPROVAL','HELD','BLOCKED'`;

/**
 * `diff_stat` is JSON text. At most one hold per task is open (`ended_at IS
 * NULL`); the partial unique index makes a second one a constraint error.
 */
const CREATE_TASK_HOLDS = `
CREATE TABLE task_holds (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES mission_tasks(id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  held_by TEXT NOT NULL,
  from_status TEXT NOT NULL,
  runtime_profile_id TEXT NOT NULL,
  session_before TEXT,
  session_after TEXT,
  pty_pid INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  ended_by TEXT,
  ending TEXT CHECK (ending IN ('continued','released')),
  consumed_at TEXT,
  diff_stat TEXT,
  dir TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_task_holds_open ON task_holds(task_id) WHERE ended_at IS NULL;
CREATE INDEX idx_task_holds_mission ON task_holds(mission_id);
`;

export const migration022: Migration = {
  version: 22,
  name: 'task_holds',
  up: '',
  transform: (db: SqliteHandle): void => {
    db.unsafeMode(true);
    try {
      db.pragma('writable_schema = ON');
      try {
        db.prepare(
          `UPDATE sqlite_master
              SET sql = replace(sql, :old, :new)
            WHERE type = 'table' AND name = 'mission_tasks'`,
        ).run({ old: OLD_STATUSES, new: NEW_STATUSES });
      } finally {
        db.pragma('writable_schema = OFF');
      }

      const row = db
        .prepare<[], { sql: string }>(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mission_tasks'`,
        )
        .get();

      // A `replace()` that matched nothing is a silent no-op; assert instead.
      if (!(row?.sql ?? '').includes(`'HELD'`)) {
        throw new TandemiseError(
          'INTERNAL',
          'Migration 022 did not widen the mission_tasks status constraint; HELD would still be rejected.',
          { details: { schema: row?.sql ?? null } },
        );
      }

      // Without the bump this connection keeps the old constraint cached.
      const version = db.pragma('schema_version', { simple: true }) as number;
      db.pragma(`schema_version = ${version + 1}`);
    } finally {
      db.unsafeMode(false);
    }

    db.exec(CREATE_TASK_HOLDS);
  },
};
