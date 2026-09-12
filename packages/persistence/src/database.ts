import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Sqlite from 'better-sqlite3';
import { TandemiseError, nullLogger, type Logger } from '@tandemise/shared';

/** The raw better-sqlite3 handle. Exposed so repositories can prepare statements. */
export type SqliteHandle = Sqlite.Database;

/**
 * The database as the rest of the package sees it.
 *
 * A thin wrapper rather than the bare handle, because two things must be true
 * for every caller and are easy to forget otherwise: transactions nest safely
 * (better-sqlite3 turns an inner `transaction()` into a savepoint), and closing
 * is idempotent so shutdown ordering bugs do not surface as `database is
 * closed` errors.
 */
export interface TandemiseDatabase {
  readonly handle: SqliteHandle;
  /** Filesystem path, or `:memory:`. */
  readonly path: string;
  /**
   * Runs `fn` in an immediate transaction, rolling back if it throws. Nests via
   * savepoints, so a repository that transacts internally composes inside a
   * larger unit of work instead of committing early.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** Filesystem path to the database file, or `:memory:` for an ephemeral one. */
  readonly path: string;
  readonly logger?: Logger;
}

/**
 * Opens (creating if needed) the Tandemise database with the pragmas the
 * daemon's concurrency model depends on.
 *
 * WAL is not a performance tweak here, it is a correctness requirement: the
 * daemon reads the mission timeline while worker supervision writes events, and
 * in the default rollback journal a writer blocks every reader. `busy_timeout`
 * covers the remaining window where two writers collide, and turns what would
 * be an immediate SQLITE_BUSY into a short wait. `synchronous=NORMAL` is the
 * documented safe pairing with WAL - durable across process crash, which is the
 * failure mode we actually recover from (MVP.md §21.2).
 */
export function openDatabase(options: OpenDatabaseOptions): TandemiseDatabase {
  const log = (options.logger ?? nullLogger).child({ component: 'persistence' });
  const isMemory = options.path === ':memory:';

  if (!isMemory) {
    try {
      mkdirSync(dirname(options.path), { recursive: true });
    } catch (cause) {
      throw new TandemiseError('INTERNAL', `Cannot create database directory for ${options.path}`, { cause });
    }
  }

  let handle: SqliteHandle;
  try {
    handle = new Sqlite(options.path);
  } catch (cause) {
    throw new TandemiseError('INTERNAL', `Cannot open database at ${options.path}`, { cause });
  }

  // An in-memory database has no journal to write and cannot be shared, so WAL
  // is meaningless there; SQLite silently keeps `memory` mode either way.
  if (!isMemory) handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');
  handle.pragma('busy_timeout = 5000');
  handle.pragma('synchronous = NORMAL');

  log.debug('database opened', { path: options.path });

  let closed = false;
  return {
    handle,
    path: options.path,
    transaction<T>(fn: () => T): T {
      // BEGIN IMMEDIATE, not the default BEGIN DEFERRED.
      //
      // Every transaction here reads before it writes - `append` reads MAX
      // (sequence) then inserts, `update` reads the row then rewrites it. A
      // deferred transaction starts as a reader and must upgrade to a writer on
      // that first write, and in WAL mode SQLite refuses the upgrade with
      // SQLITE_BUSY the moment another connection has committed since the read,
      // *without* invoking the busy handler: retrying could deadlock, so
      // `busy_timeout` deliberately does not apply. Taking the write lock up
      // front makes busy_timeout apply again, so concurrent writers queue
      // instead of failing. Verified by scratch/persistence-check.mjs, which
      // fails with "database is locked" if this is DEFERRED.
      return handle.transaction(fn).immediate();
    },
    close(): void {
      if (closed) return;
      closed = true;
      handle.close();
      log.debug('database closed', { path: options.path });
    },
  };
}
