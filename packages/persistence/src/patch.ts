/**
 * Applies a partial update to an entity.
 *
 * Every `update(id, patch)` port takes a `Partial<...>`. With
 * `exactOptionalPropertyTypes` off, `{ status: undefined }` is assignable, and
 * a naive spread would then wipe the stored value. Only keys that are actually
 * present *and* defined are applied, so an accidental `undefined` is a no-op
 * rather than a silent data loss.
 */
export function applyPatch<T extends object>(current: T, patch: Partial<T>): T {
  const next = { ...current };
  for (const key of Object.keys(patch) as Array<keyof T>) {
    const value = patch[key];
    if (value !== undefined) next[key] = value as T[keyof T];
  }
  return next;
}
