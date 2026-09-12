/**
 * JSON column helpers.
 *
 * Several entity fields are arrays or objects with no useful relational shape
 * (a runtime's adapter-specific settings, an approval's evidence list). Those
 * live in TEXT columns as JSON. Everything a *query* filters or joins on stays
 * a real column - JSON is for payload, never for predicates.
 */

/**
 * Decodes a JSON column. A row written by an older binary, hand-edited, or
 * truncated by a crash must not take the daemon down on read: the fallback is
 * returned instead. Callers pass a fallback that is valid for the field, so a
 * corrupt `constraints` column degrades to an empty list rather than a throw.
 */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed === null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

/** Same, but `null` in the column means "absent" rather than "empty". */
export function parseJsonOrNull<T>(text: string | null | undefined): T | null {
  if (text === null || text === undefined || text === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed === null ? null : (parsed as T);
  } catch {
    return null;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

export function toJsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** SQLite has no boolean type; 0/1 with a CHECK constraint is the convention. */
export function toSqlBool(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function fromSqlBool(value: number): boolean {
  return value !== 0;
}
