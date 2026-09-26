import type { RoleModels, RoleRepositoryPort, RoleTemplate } from '@tandemise/domain';
import { hasRoleModels, normalizeRoleModels } from '@tandemise/domain';
import type { UpsertRoleRequest } from '@tandemise/api-contract';
import type { Clock, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId } from '@tandemise/shared';
import { BUILT_IN_ROLE_MAP } from '../roles/built-in.js';
import type { RoleService } from '../services.js';

/**
 * Role templates (MVP.md §16.3).
 *
 * A project owns its roles: they are seeded into it when it is created, and
 * sharpening the reviewer's contract for one codebase leaves every other
 * project alone. That is the point of scoping them - a house style is a
 * property of a codebase, not of the machine it is checked out on.
 *
 * Removing a role therefore means two different things, and both are what the
 * word should mean in context. A role someone wrote is deleted. A built-in is
 * restored to its shipped definition instead, because the workflow presets name
 * built-in roles by id and a plan referencing a role that no longer exists
 * fails validation - losing `review` would quietly break planning for the whole
 * project, with no way back through the UI.
 */
export class RoleServiceImpl implements RoleService {
  constructor(
    private readonly roles: RoleRepositoryPort,
    private readonly clock: Clock,
  ) {}

  list(workspaceId?: string): readonly RoleTemplate[] {
    return this.roles.list(workspaceId === undefined ? null : asId<'WorkspaceId'>(workspaceId));
  }

  upsert(request: UpsertRoleRequest): RoleTemplate {
    const workspaceId = asId<'WorkspaceId'>(request.workspaceId);
    const existing = this.roles.get(request.id, workspaceId);
    const now = this.clock.now();
    const role: RoleTemplate = {
      id: request.id,
      workspaceId,
      name: request.name,
      summary: request.summary,
      instructions: request.instructions,
      defaultCapabilities: request.defaultCapabilities,
      producesArtifacts: request.producesArtifacts,
      consumesArtifacts: request.consumesArtifacts,
      defaultIsolation: request.defaultIsolation,
      outputContract: request.outputContract,
      // Omitted keeps what the role has (a client from before P12 must not
      // wipe them); null clears them.
      models: request.models === undefined
        ? existing?.models ?? null
        : request.models === null ? null : nullIfEmpty(normalizeRoleModels(request.models)),
      // An edited built-in keeps the flag: the UI shows it as a customized
      // built-in, and `remove` restores the shipped definition.
      builtIn: BUILT_IN_ROLE_MAP.has(request.id),
      // Only this project's own row has a createdAt to keep; `get` may have
      // returned the global one.
      createdAt: existing?.workspaceId === workspaceId ? existing.createdAt : now,
      updatedAt: now,
    };
    return this.roles.upsert(role);
  }

  /**
   * Brings built-in roles nobody has edited up to the shipped definition.
   *
   * Built-ins are copied into the database, so a new default in code - the
   * Designer gaining the `design` capability that reaches a connected design
   * app - never reached an install seeded before it. The design task was
   * granted three read capabilities, told "this session has no Open Design
   * tools", and wrote a Markdown brief instead.
   *
   * Only untouched rows move: a global built-in row is never edited (an edit
   * writes a project-scoped copy), and a project-scoped built-in counts as
   * untouched while it still carries its seeding timestamp. A role someone
   * sharpened is theirs and stays exactly as they left it.
   */
  refreshBuiltIns(workspaceIds: readonly WorkspaceId[]): number {
    let refreshed = 0;
    const now = this.clock.now();
    // Read before any global row changes: a project row identical to the
    // global it was copied from was never edited, whatever its timestamps say.
    // Projects seeded before seeding wrote matching timestamps depend on this.
    const globals = new Map(this.roles.list(null).filter((r) => r.workspaceId === null).map((r) => [r.id, r]));
    const refresh = (stored: RoleTemplate, workspaceId: WorkspaceId | null): void => {
      const shipped = BUILT_IN_ROLE_MAP.get(stored.id);
      if (shipped === undefined || !stored.builtIn) return;
      const copiedUnchanged = workspaceId !== null
        && globals.has(stored.id) && sameDefinition(stored, globals.get(stored.id)!);
      const unedited = workspaceId === null || stored.createdAt === stored.updatedAt || copiedUnchanged;
      if (!unedited || sameDefinition(stored, shipped)) return;
      this.roles.upsert({
        ...shipped,
        workspaceId,
        createdAt: stored.createdAt,
        // A scoped row is stamped createdAt === updatedAt so it stays
        // recognisably unedited for the next upgrade.
        updatedAt: workspaceId === null ? now : stored.createdAt,
      } as RoleTemplate);
      refreshed++;
    };
    for (const workspaceId of workspaceIds) {
      for (const role of this.roles.list(workspaceId)) {
        if (role.workspaceId === workspaceId) refresh(role, workspaceId);
      }
    }
    for (const role of globals.values()) refresh(role, null);
    return refreshed;
  }

  remove(id: string, workspaceId: WorkspaceId): void {
    const scoped = this.roles.get(id, workspaceId);
    if (scoped === undefined) {
      throw TandemiseError.notFound('Role', id);
    }

    const builtIn = BUILT_IN_ROLE_MAP.get(id);
    if (builtIn !== undefined) {
      // Restore rather than delete. The presets name this id.
      // Restored reads as unedited again (updatedAt === createdAt), so later
      // upgrades to the shipped role reach it.
      this.roles.upsert({ ...builtIn, workspaceId, createdAt: scoped.createdAt, updatedAt: scoped.createdAt });
      return;
    }
    this.roles.remove(id, workspaceId);
  }
}

function sameDefinition(stored: RoleTemplate, shipped: Omit<RoleTemplate, 'workspaceId' | 'createdAt' | 'updatedAt'> | RoleTemplate): boolean {
  const pick = (r: typeof shipped) => JSON.stringify([
    r.name, r.summary, r.instructions, [...r.defaultCapabilities].sort(), [...r.producesArtifacts].sort(),
    [...r.consumesArtifacts].sort(), r.defaultIsolation, r.outputContract,
  ]);
  return pick(stored) === pick(shipped);
}

function nullIfEmpty(models: RoleModels): RoleModels | null {
  return hasRoleModels(models) ? models : null;
}
