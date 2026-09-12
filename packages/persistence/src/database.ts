import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Sqlite from 'better-sqlite3';
import { TandemiseError, nullLogger, type Logger } from '@tandemise/shared';

/** The raw better-sqlite3 handle. Exposed so repositories can prepare statements. */
export type SqliteHandle = Sqlite.Database;

/** A prepared statement bound with named parameters. */
export type Stmt<Params extends object, Row = unknown> = Sqlite.Statement<Params, Row>;

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
  /** Runs `fn` in a transaction, rolling back if it throws. Nests via savepoints. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** Filesystem path to the database file, or `:memory:` for an ephemeral one. */
  readonly path: string;
  readonly logger?: Logger;
  /** Opens the file read-only. Used by diagnostics that must not mutate state. */
  readonly readonly?: boolean;
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
    handle = new Sqlite(options.path, { readonly: options.readonly ?? false });
  } catch (cause) {
    throw new TandemiseError('INTERNAL', `Cannot open database at ${options.path}`, { cause });
  }

  // An in-memory database has no journal to write and cannot be shared, so WAL
  // is meaningless there; SQLite silently keeps `memory` mode either way.
  if (!isMemory && !options.readonly) handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');
  handle.pragma('busy_timeout = 5000');
  handle.pragma('synchronous = NORMAL');

  log.debug('database opened', { path: options.path });

  let closed = false;
  return {
    handle,
    path: options.path,
    transaction<T>(fn: () => T): T {
      return handle.transaction(fn)();
    },
    close(): void {
      if (closed) return;
      closed = true;
      handle.close();
      log.debug('database closed', { path: options.path });
    },
  };
}
