import type { UnitOfWork } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';

/**
 * One transactional boundary across every repository.
 *
 * All repositories share a single better-sqlite3 connection, so "the same
 * transaction" needs no ambient context or per-repository session object: a
 * transaction opened here covers every statement they run until it returns.
 * better-sqlite3 turns a nested `transaction()` into a savepoint, so a
 * repository that transacts internally composes correctly inside a larger unit
 * of work instead of committing early.
 */
export function createUnitOfWork(db: TandemiseDatabase): UnitOfWork {
  return {
    transaction<T>(fn: () => T): T {
      return db.transaction(fn);
    },
  };
}
