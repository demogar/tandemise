import type { RuntimeCapability, RuntimeProfile } from '@tandemise/domain';

/**
 * What a profile can do: what the adapter reports, plus what the profile
 * declares.
 *
 * `profile.capabilities` is the user's correction to an adapter's guess (they
 * may know their generic CLI speaks MCP), so it must count. It adds rather than
 * replaces: a profile created without an explicit list stores the adapter's
 * base capabilities, and letting that stored copy win would silently drop
 * whatever the adapter's settings declare, or a capability the adapter gained
 * after the profile was saved.
 *
 * A stored list that is exactly the adapter's defaults is what create() writes
 * when nobody chose; it is no override, so settings can still narrow what the
 * profile offers.
 */
export function withDeclaredCapabilities(
  profile: Pick<RuntimeProfile, 'capabilities'>, reported: readonly RuntimeCapability[],
  adapterDefaults: readonly RuntimeCapability[],
): readonly RuntimeCapability[] {
  if (profile.capabilities.length === 0 || sameSet(profile.capabilities, adapterDefaults)) return reported;
  return [...new Set([...reported, ...profile.capabilities])];
}

function sameSet(a: readonly RuntimeCapability[], b: readonly RuntimeCapability[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((c) => right.has(c));
}
