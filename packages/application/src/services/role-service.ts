import type { RoleRepositoryPort, RoleTemplate } from '@tandemise/domain';
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
      // An edited built-in keeps the flag: the UI shows it as a customized
      // built-in, and `remove` restores the shipped definition.
      builtIn: BUILT_IN_ROLE_MAP.has(request.id),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return this.roles.upsert(role);
  }

  remove(id: string, workspaceId: WorkspaceId): void {
    const scoped = this.roles.get(id, workspaceId);
    if (scoped === undefined) {
      throw TandemiseError.notFound('Role', id);
    }

    const builtIn = BUILT_IN_ROLE_MAP.get(id);
    if (builtIn !== undefined) {
      // Restore rather than delete. The presets name this id.
      const now = this.clock.now();
      this.roles.upsert({ ...builtIn, workspaceId, createdAt: scoped.createdAt, updatedAt: now });
      return;
    }
    this.roles.remove(id, workspaceId);
  }
}
