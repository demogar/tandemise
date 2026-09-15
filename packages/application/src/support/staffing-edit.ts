import type { Member, RoleStaffing, StaffingPatch, Team } from '@tandemise/domain';
import { validateStaffing, validateTeam } from '@tandemise/domain';
import { TandemiseError } from '@tandemise/shared';

/** A role staffing patch as the API sends it: `null` removes the role. */
export type RoleStaffingEdit = Readonly<Record<string, StaffingPatch | null>>;

/**
 * Merges per role, and field by field within a role.
 *
 * Replacing the whole map was the routing bug this fixes: saving one role's
 * runtimes erased every other role's, because the screen only sent the one
 * it was showing.
 */
export function mergeRoleStaffing(current: RoleStaffing, edit: RoleStaffingEdit): {
  readonly next: RoleStaffing;
  readonly touched: readonly string[];
} {
  const next: Record<string, StaffingPatch> = { ...current };
  const touched: string[] = [];
  for (const [role, value] of Object.entries(edit)) {
    if (value === null) {
      delete next[role];
      continue;
    }
    touched.push(role);
    next[role] = { ...current[role], ...definedOnly(value) };
  }
  return { next, touched };
}

/** Throws VALIDATION naming every issue, each prefixed with its role. */
export function assertStaffing(team: Team, staffing: RoleStaffing, roles: readonly string[]): void {
  const issues = roles.flatMap((role) => validateStaffing(team, staffing[role] ?? {}).map((i) => `${role}.${i}`));
  if (issues.length > 0) throw TandemiseError.validation(issues.join(' '), { issues });
}

/** Throws VALIDATION when the team as it would be after a change breaks an invariant. */
export function assertTeam(members: readonly Member[]): void {
  const issues = validateTeam(members);
  if (issues.length > 0) throw TandemiseError.validation(issues.join(' '), { issues });
}

// An explicit `undefined` from a caller must not erase a stored field.
function definedOnly(patch: StaffingPatch): StaffingPatch {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as StaffingPatch;
}
