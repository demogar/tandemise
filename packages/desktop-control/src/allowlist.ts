import { TandemiseError, type Clock } from '@tandemise/shared';
import { capabilityMatches, type Capability, type WorkerAssignment } from '@tandemise/domain';
import { isExpired } from '@tandemise/integrations-core';

/** Root of the desktop capability tree; a grant for it covers `desktop.click` etc. */
export const DESKTOP_CAPABILITY = 'desktop';

/**
 * The app allowlist for one assignment and capability.
 *
 * The entries are the `resourceScope` of every live grant covering the
 * capability - bundle ids, or `*` for "any app".
 */
export function allowedApps(
  assignment: WorkerAssignment,
  capability: Capability,
  clock: Clock,
): readonly string[] {
  return assignment.grants
    .filter(
      (g) =>
        g.approvalMode !== 'deny' && capabilityMatches(g.capability, capability) && !isExpired(g, clock),
    )
    .flatMap((g) => g.resourceScope);
}

/**
 * Bundle ids match exactly (case-insensitively - macOS treats them that way),
 * as `*`, or through a trailing-segment wildcard such as `com.apple.*`.
 *
 * Note this is *not* `resourceInScope` from `@tandemise/integrations-core`.
 * That helper reads an empty scope as "unrestricted", which is the right
 * default for a capability that is not resource-shaped. Desktop control is the
 * opposite case: MVP.md §19.2 requires app access to be allowlisted per role and
 * mission, so an empty scope here means *no app*, and a grant that names no app
 * grants nothing.
 */
export function bundleIdInScope(scope: readonly string[], bundleId: string): boolean {
  const target = bundleId.toLowerCase();
  return scope.some((entry) => {
    const pattern = entry.trim().toLowerCase();
    if (pattern === '*') return true;
    if (pattern === target) return true;
    if (pattern.endsWith('.*')) return target.startsWith(pattern.slice(0, -1));
    return false;
  });
}

/**
 * The provider-side enforcement point (MVP.md §19.2).
 *
 * The policy engine checks this too, and that is the point: the check lives here
 * as well so that *no* path to the helper - a directly constructed tool, a test
 * harness, a future driver reusing these tools - can reach an app the assignment
 * was never granted. A control that only exists in one layer is a control that
 * a refactor can delete by accident.
 */
export function assertAppAllowed(
  toolName: string,
  assignment: WorkerAssignment,
  capability: Capability,
  bundleId: string,
  clock: Clock,
): void {
  const scope = allowedApps(assignment, capability, clock);
  if (scope.length === 0) {
    throw TandemiseError.permissionDenied(
      `'${toolName}' is not permitted: this assignment has no desktop app allowlisted for '${capability}'`,
      { tool: toolName, capability, bundleId },
    );
  }
  if (!bundleIdInScope(scope, bundleId)) {
    throw TandemiseError.permissionDenied(
      `'${toolName}' is not permitted to touch '${bundleId}'; this assignment is allowed: ${scope.join(', ')}`,
      { tool: toolName, capability, bundleId, allowed: scope },
    );
  }
}

/** Whether the assignment may reach every app - the only case full-screen capture is safe. */
export function hasUnrestrictedAppScope(
  assignment: WorkerAssignment,
  capability: Capability,
  clock: Clock,
): boolean {
  return allowedApps(assignment, capability, clock).some((entry) => entry.trim() === '*');
}
