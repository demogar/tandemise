import type { SqlHandle } from './sql.js';
import { COORD_DDL_V1 } from './schema.js';

/**
 * Coordination's own migration stream, recorded in `coord_meta.schema_version`
 * and kept apart from the daemon's `MIGRATIONS` list so the two can never
 * tangle (spec §Data model, "Schema versioning"). The same rules as
 * `packages/persistence/src/migrations/index.ts`: append-only, contiguous, and
 * a released migration is immutable.
 */
export interface CoordMigration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

export const COORDINATION_MIGRATIONS: readonly CoordMigration[] = [
  { version: 1, name: 'initial', up: COORD_DDL_V1 },
];

export const COORD_SCHEMA_VERSION: number = COORDINATION_MIGRATIONS.length;

function assertOrdered(list: readonly CoordMigration[]): void {
  list.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Coordination migrations must be contiguous from 1; found ${m.version} at position ${i + 1}.`);
  });
}

function currentVersion(db: SqlHandle, key: string): number {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coord_meta'`).get();
  if (!exists) return 0;
  const row = db.prepare(`SELECT value FROM coord_meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

function apply(db: SqlHandle, list: readonly CoordMigration[], key: string): { from: number; to: number } {
  assertOrdered(list);
  const from = currentVersion(db, key);
  const newest = list.length;
  if (from > newest) {
    throw new Error(`This coordination database is at version ${from}, newer than this build understands (${newest}). Update Tandemise or the relay.`);
  }
  for (const m of list) {
    if (m.version <= from) continue;
    db.transaction(() => {
      db.exec(m.up);
      db.prepare(`INSERT INTO coord_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(m.version));
    })();
  }
  return { from, to: Math.max(from, newest) };
}

/** Brings the shared `coord_*` tables up to date. A second run is a no-op. */
export function migrateCoordination(db: SqlHandle): { from: number; to: number } {
  return apply(db, COORDINATION_MIGRATIONS, 'schema_version');
}
