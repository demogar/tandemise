/**
 * Internal feature flags.
 *
 * Mid-flight behavior lives behind these so a change is one boolean here plus
 * the call sites that read it — flip it back without a rewrite, or delete the
 * entry (and its call sites) once the behavior becomes permanent.
 */
export const FEATURE_FLAGS = {
  /**
   * The team is you + your agents. Staffing presets that hand a role to a
   * person, or to a pool of people, are hidden; you remain the responsible
   * person who approves and checks.
   *
   * Scope note: this flag gates the *staffing preset picker* only. The removed
   * "Add person" button and drawer were deleted unconditionally, so flipping
   * this back to `false` restores the presets but not those flows.
   */
  agentsOnly: true,
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;

/** Reads a flag. Call sites gate behavior on this rather than on raw literals. */
export function flag(name: FeatureFlag): boolean {
  return FEATURE_FLAGS[name];
}
