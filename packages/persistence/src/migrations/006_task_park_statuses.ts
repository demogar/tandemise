import { TandemiseError } from '@tandemise/shared';
import type { SqliteHandle } from '../database.js';
import type { Migration } from './types.js';

/**
 * Lets a task record that it is parked.
 *
 * `mission_tasks.status` carries a CHECK constraint listing the statuses
 * migration 001 knew about. Three have been added to the domain since, and the
 * constraint was never widened to match - so every one of them threw
 * `SQLITE_CONSTRAINT_CHECK` the moment the scheduler tried to write it:
 *
 *   - `AWAITING_HUMAN`    a step a person carries out
 *   - `AWAITING_EXTERNAL` a step polling something off this machine
 *   - `AWAITING_INPUT`    new here: an agent is running and has asked a question
 *
 * The first two shipped broken. Any workflow containing a `human` or `wait`
 * step failed on its first dispatch - which is every workflow modelled on a
 * real process: a design someone makes by hand, a CI run, a deploy. The bug was
 * invisible to the workflow tests because they exercised the compiler, which
 * produces the plan, and never the scheduler, which writes the status.
 *
 * Why the stored schema is edited rather than the table rebuilt
 * ------------------------------------------------------------
 * Seven tables reference `mission_tasks`, several with ON DELETE CASCADE:
 * `runs`, `evaluations`, `check_results`, `worker_assignments`,
 * `execution_targets`, `task_dependencies`. With `foreign_keys = ON` - which is
 * how the daemon opens the database - the standard create/copy/drop/rename
 * dance cascades every one of those away. Upgrading would silently delete the
 * execution history of every mission that had ever run.
 *
 * Editing the schema text in place is the conservative option here, not the
 * clever one. No row is rewritten, no index is dropped, no foreign key is
 * disturbed; the only change is the list of strings inside one CHECK, which
 * leaves the on-disk format identical - the condition SQLite places on this.
 *
 * All of it lives in `transform` because two steps need the handle rather than
 * a statement: better-sqlite3 refuses to modify `sqlite_master` outside unsafe
 * mode, and the cache-invalidating pragma takes a literal, not an expression.
 */

/** Read as a diff: this is the whole schema change. */
const OLD_STATUSES = `'PENDING','READY','RUNNING','AWAITING_APPROVAL','BLOCKED'`;
const NEW_STATUSES =
  `'PENDING','READY','RUNNING','AWAITING_INPUT','AWAITING_HUMAN','AWAITING_EXTERNAL',`
  + `'AWAITING_APPROVAL','BLOCKED'`;

const ADDED = ['AWAITING_INPUT', 'AWAITING_HUMAN', 'AWAITING_EXTERNAL'] as const;

export const migration006: Migration = {
  version: 6,
  name: 'task_park_statuses',
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
        // Left on, every later statement in this process could rewrite the
        // schema. Restored even if the update throws.
        db.pragma('writable_schema = OFF');
      }

      const row = db
        .prepare<[], { sql: string }>(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mission_tasks'`,
        )
        .get();

      // A `replace()` that matched nothing is a silent no-op, and the failure
      // would resurface as the original constraint error on some user's first
      // human step. Assert the post-condition rather than trusting the edit.
      const missing = ADDED.filter((status) => !(row?.sql ?? '').includes(status));
      if (missing.length > 0) {
        throw new TandemiseError(
          'INTERNAL',
          `Migration 006 did not widen the mission_tasks status constraint; `
          + `${missing.join(', ')} would still be rejected.`,
          { details: { schema: row?.sql ?? null } },
        );
      }

      // An edit to `sqlite_master` is invisible to any connection holding a
      // cached schema - including this one. Without this bump the constraint
      // still reads as the old list for the life of the process, so the
      // migration appears to succeed and the very next write fails anyway.
      // Verified: skipping it reproduces the original CHECK failure in-session.
      const version = db.pragma('schema_version', { simple: true }) as number;
      db.pragma(`schema_version = ${version + 1}`);
    } finally {
      db.unsafeMode(false);
    }
  },
};
