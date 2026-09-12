import type { RoleRepositoryPort, RoleTemplate } from '@tandemise/domain';
import type { UpsertRoleRequest } from '@tandemise/api-contract';
import type { Clock, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId } from '@tandemise/shared';
import { BUILT_IN_ROLE_MAP } from '../roles/built-in.js';
import type { RoleService } from '../services.js';

/**
 * Role templates (MVP.md §16.3).
 *
 * A workspace edits a built-in role by *overriding* it - the global template is
 * never mutated. That is what makes "reset to default" a delete rather than a
 * re-seed, and it means an upgrade that improves a built-in role's instructions
 * reaches every workspace that has not deliberately diverged.
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
      // A workspace override of a built-in keeps the flag: the UI shows it as
      // "customized built-in", and `remove` is allowed to restore the original.
      builtIn: BUILT_IN_ROLE_MAP.has(request.id),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return this.roles.upsert(role);
  }

  remove(id: string, workspaceId: WorkspaceId): void {
    const scoped = this.roles.get(id, workspaceId);
    if (scoped === undefined || scoped.workspaceId === null) {
      throw new TandemiseError(
        'PRECONDITION_FAILED',
        `Role '${id}' is a built-in template and is not deletable. Override it instead.`,
        { details: { roleId: id } },
      );
    }
    this.roles.remove(id, workspaceId);
  }
}
