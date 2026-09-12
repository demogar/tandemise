/**
 * Applies a partial update to an entity.
 *
 * Every `update(id, patch)` port takes a `Partial<...>`. With
 * `exactOptionalPropertyTypes` off, `{ status: undefined }` is assignable, and
 * a naive spread would then wipe the stored value. Only keys that are actually
 * present *and* defined are applied, so an accidental `undefined` is a no-op
 * rather than a silent data loss.
 */
export function applyPatch<T extends object, P extends Partial<T>>(current: T, patch: P): T {
  // `P` is a second type parameter so that the entity type is inferred from
  // `current`. Inferring it from the patch would pin `T` to the port's
  // `Omit<Entity, 'id' | ...>` and lose the fields the patch is not allowed to
  // carry - which are exactly the ones the result must keep.
  const next: T = { ...current };
  for (const key of Object.keys(patch) as Array<keyof T>) {
    const value = (patch as Partial<T>)[key];
    if (value !== undefined) next[key] = value as T[keyof T];
  }
  return next;
}
