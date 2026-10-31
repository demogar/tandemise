/**
 * The smallest SQL surface the coordination store needs. A `better-sqlite3`
 * `Database` satisfies it structurally, so this package never imports the
 * driver itself, and a later swap to another driver is one adapter.
 */
export interface SqlStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqlHandle {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  transaction<A extends unknown[], T>(fn: (...args: A) => T): (...args: A) => T;
}
