/**
 * `@tandemise/coordination/rules`: the pure rules only (item refs, staleness,
 * take-over, the sentences people read), with no store, SQL or crypto. The
 * application imports this, so it never loads the store it doesn't own.
 */
export * from './item-ref.js';
export * from './rules.js';
