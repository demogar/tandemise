import type {
  Repository, RepoRepositoryPort, RoleRepositoryPort, RuntimeProfileRepositoryPort, Workspace,
  WorkspaceRepositoryPort,
} from '@tandemise/domain';
import {
  DEFAULT_AUTONOMY, DEFAULT_CONCURRENCY, EMPTY_KNOWLEDGE, NO_CHECKS,
} from '@tandemise/domain';
import type {
  AddRepositoryRequest, CreateWorkspaceRequest, RepositoryProbe, UpdateWorkspaceRequest,
  WorkspaceView,
} from '@tandemise/api-contract';
import type { Clock, RepositoryId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, expandPath, ids } from '@tandemise/shared';
import { BUILT_IN_ROLES } from '../roles/built-in.js';
import type { RepositoryProber } from '../support/repository-prober.js';
import type { WorkspaceService } from '../services.js';

/**
 * Workspaces, their repositories, and the roles they start with
 * (MVP.md §13.1, §16.1).
 *
 * Creating a workspace seeds the built-in roles as *global* templates rather
 * than as copies. A copy would freeze an improved role instruction at the
 * version that happened to ship when the workspace was created, and would make
 * "what changed?" unanswerable across an upgrade. The workspace still owns its
 * routing, which is the part that is genuinely per-installation.
 */
export class WorkspaceServiceImpl implements WorkspaceService {
  constructor(
    private readonly workspaces: WorkspaceRepositoryPort,
    private readonly repositories: RepoRepositoryPort,
    private readonly roles: RoleRepositoryPort,
    private readonly runtimeProfiles: RuntimeProfileRepositoryPort,
    private readonly prober: RepositoryProber,
    private readonly clock: Clock,
  ) {}

  list(): readonly WorkspaceView[] {
    return this.workspaces.list().map((w) => this.#view(w));
  }

  async create(request: CreateWorkspaceRequest): Promise<WorkspaceView> {
    this.#seedBuiltInRoles();

    const id = ids.workspace();
    const workspace = this.workspaces.create({
      id,
      name: request.name,
      defaultRepositoryId: null,
      autonomy: DEFAULT_AUTONOMY,
      concurrency: DEFAULT_CONCURRENCY,
      routing: this.#defaultRouting(),
      defaultAutonomyLevel: 'balanced',
      knowledge: EMPTY_KNOWLEDGE,
    });

    if (request.repositoryPath !== undefined) {
      const repository = await this.addRepository(id, { path: request.repositoryPath });
      this.workspaces.update(id, { defaultRepositoryId: repository.id, updatedAt: this.clock.now() });
    }
    return this.view(id);
  }

  view(id: WorkspaceId): WorkspaceView {
    return this.#view(this.#require(id));
  }

  update(id: WorkspaceId, patch: UpdateWorkspaceRequest): WorkspaceView {
    const workspace = this.#require(id);
    this.workspaces.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.defaultRepositoryId !== undefined
        ? { defaultRepositoryId: patch.defaultRepositoryId as RepositoryId | null }
        : {}),
      ...(patch.autonomy !== undefined ? { autonomy: patch.autonomy } : {}),
      ...(patch.concurrency !== undefined ? { concurrency: patch.concurrency } : {}),
      ...(patch.routing !== undefined ? { routing: patch.routing } : {}),
      ...(patch.knowledge !== undefined
        ? { knowledge: { ...workspace.knowledge, ...patch.knowledge } }
        : {}),
      updatedAt: this.clock.now(),
    });
    return this.view(id);
  }

  listRepositories(id: WorkspaceId): readonly Repository[] {
    return this.repositories.listByWorkspace(id);
  }

  async addRepository(id: WorkspaceId, request: AddRepositoryRequest): Promise<Repository> {
    this.#require(id);
    const probe = await this.prober.probe(request.path);
    if (!probe.isGitRepository) {
      throw TandemiseError.validation(
        `${probe.path} is not a git repository. Tandemise isolates work in worktrees, which requires one.`,
        { path: probe.path, warnings: probe.warnings },
      );
    }

    const existing = this.repositories.listByWorkspace(id).find((r) => r.path === probe.path);
    if (existing !== undefined) return existing;

    // Detected commands are the default, and anything the caller states wins.
    // Detection is a convenience; a configured command is a decision.
    const checks = { ...NO_CHECKS, ...probe.detectedChecks, ...(request.checks ?? {}) };
    const created = this.repositories.create({
      id: ids.repository(),
      workspaceId: id,
      name: request.name ?? probe.name,
      path: probe.path,
      defaultBranch: probe.defaultBranch ?? probe.currentBranch ?? 'main',
      remoteUrl: probe.remoteUrl,
      checks,
    });

    // The first repository a workspace gets becomes its default. Without this a
    // mission created without an explicit repository silently gets none, and
    // every task that needed a worktree fails for want of a repository the user
    // is looking straight at.
    const workspace = this.#require(id);
    if (workspace.defaultRepositoryId === null) {
      this.workspaces.update(id, { defaultRepositoryId: created.id, updatedAt: this.clock.now() });
    }
    return created;
  }

  updateRepository(id: RepositoryId, patch: Partial<AddRepositoryRequest>): Repository {
    const repository = this.repositories.get(id);
    if (repository === undefined) throw TandemiseError.notFound('Repository', id);
    return this.repositories.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.path !== undefined ? { path: expandPath(patch.path) } : {}),
      ...(patch.checks !== undefined ? { checks: { ...repository.checks, ...patch.checks } } : {}),
      updatedAt: this.clock.now(),
    });
  }

  removeRepository(id: RepositoryId): void {
    const repository = this.repositories.get(id);
    if (repository === undefined) throw TandemiseError.notFound('Repository', id);
    this.repositories.remove(id);
    const workspace = this.workspaces.get(repository.workspaceId);
    if (workspace?.defaultRepositoryId === id) {
      this.workspaces.update(workspace.id, { defaultRepositoryId: null, updatedAt: this.clock.now() });
    }
  }

  probeRepository(path: string): Promise<RepositoryProbe> {
    return this.prober.probe(path);
  }

  // ------------------------------------------------------------------ internals

  /**
   * Idempotent: `upsert` on a global role that already exists rewrites the same
   * row, which is what makes an upgraded built-in instruction take effect on the
   * next daemon start without a migration.
   */
  #seedBuiltInRoles(): void {
    const now = this.clock.now();
    for (const role of BUILT_IN_ROLES) {
      const existing = this.roles.get(role.id, null);
      this.roles.upsert({
        ...role,
        workspaceId: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    }
  }

  /**
   * Every built-in role, pointed at the runtimes that exist right now, in the
   * order they were configured.
   *
   * A role with no entry falls back to "any healthy runtime", so seeding an
   * empty list would be indistinguishable from seeding nothing. Recording the
   * concrete profiles instead means the routing screen opens with something to
   * read and to reorder, which is the point of routing being per-role at all.
   */
  #defaultRouting(): Record<string, readonly string[]> {
    const available = this.runtimeProfiles.list(null).filter((p) => p.enabled).map((p) => p.id);
    if (available.length === 0) return {};
    return Object.fromEntries(BUILT_IN_ROLES.map((role) => [role.id, available]));
  }

  #view(workspace: Workspace): WorkspaceView {
    return {
      workspace,
      repositories: this.repositories.listByWorkspace(workspace.id),
      roles: this.roles.list(workspace.id),
    };
  }

  #require(id: WorkspaceId): Workspace {
    const workspace = this.workspaces.get(id);
    if (workspace === undefined) throw TandemiseError.notFound('Workspace', id);
    return workspace;
  }
}
