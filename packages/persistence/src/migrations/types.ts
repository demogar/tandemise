import type { SqliteHandle } from '../database.js';

/**
 * One ordered, immutable schema change.
 *
 * `up` is raw SQL rather than a callback because a migration must be readable
 * as a diff five years from now, and because a migration that can call
 * application code will eventually call application code that has since
 * changed.
 *
 * `transform` is the escape hatch that docblock promised for the case where a
 * migration genuinely cannot be expressed as a literal statement. It is
 * deliberately given the raw handle and nothing else: it may read and write the
 * database, and it may not reach into the application. Migration 006 is the
 * first user - it must set `PRAGMA schema_version` to one more than whatever
 * the database currently holds, and a pragma takes a literal, not an
 * expression.
 */
export interface Migration {
  /** Strictly increasing, gapless from 1. Never renumbered once released. */
  readonly version: number;
  /** Short snake_case identifier, recorded alongside the version. */
  readonly name: string;
  readonly up: string;
  /** Runs immediately after `up`, inside the same transaction. */
  readonly transform?: (db: SqliteHandle) => void;
}
