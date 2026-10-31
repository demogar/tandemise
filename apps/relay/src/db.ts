import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { migrateCoordination, type SqlHandle } from '@tandemise/coordination';

export interface RelayDb {
  readonly handle: SqlHandle;
  close(): void;
}

/** Opens the relay's one SQLite file (WAL), and brings the coordination schema up to date. */
export function openRelayDb(path: string): RelayDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  const handle = db as unknown as SqlHandle;
  migrateCoordination(handle);
  return { handle, close: () => db.close() };
}
