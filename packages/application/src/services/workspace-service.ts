import type {
  Member, MemberRepositoryPort, PersonRepositoryPort, Repository, RepoRepositoryPort, RoleRepositoryPort,
  RoleStaffing, RuntimeProfileRepositoryPort, StaffingPatch, UnitOfWork, Workspace, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import {
  DEFAULT_AUTONOMY, DEFAULT_CONCURRENCY, EMPTY_KNOWLEDGE, NO_CHECKS, indexTeam, isActiveMember,
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
import type { Caller } from '../support/identity.js';

export interface WorkspaceTeamDeps {
  readonly people: PersonRepositoryPort;
  readonly members: MemberRepositoryPort;
  readonly unitOfWork: UnitOfWork;
}

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
    private readonly team: WorkspaceTeamDeps,
  ) {}

  list(): readonly WorkspaceView[] {
    return this.workspaces.list().map((w) => this.#view(w));
  }

  async create(caller: Caller, request: CreateWorkspaceRequest): Promise<WorkspaceView> {
    const person = this.team.people.get(caller.personId);
    if (person === undefined || person.removedAt !== null) throw TandemiseError.notFound('Person', caller.personId);
    const id = ids.workspace();
    this.team.unitOfWork.transaction(() => {
      this.workspaces.create({
        id,
        name: request.name,
        defaultRepositoryId: null,
        autonomy: DEFAULT_AUTONOMY,
        concurrency: DEFAULT_CONCURRENCY,
        routing: this.#defaultRouting(),
        defaultAutonomyLevel: 'balanced',
        knowledge: EMPTY_KNOWLEDGE,
      });
      // In the same transaction: a workspace without an owner could never be
      // staffed, and nobody would be responsible for its work.
      this.team.members.create({
        id: ids.member(), workspaceId: id, kind: 'person', personId: person.id, name: person.displayName,
        title: null, reportsTo: null, access: 'owner', oversight: 'delegate_owns', roleIds: [],
        runtimeProfileIds: [], integrationIds: [], status: 'active',
      });

      // Seeded into the project rather than globally: a project's roles are its
      // own, so sharpening the reviewer's contract for one codebase does not
      // quietly change how every other project reviews.
      this.#seedBuiltInRoles(id);
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
    this.team.unitOfWork.transaction(() => {
      const workspace = this.#require(id);
      const routing = patch.routing === undefined ? undefined : { ...workspace.routing, ...patch.routing };
      this.workspaces.update(id, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.defaultRepositoryId !== undefined
          ? { defaultRepositoryId: patch.defaultRepositoryId as RepositoryId | null }
          : {}),
        ...(patch.autonomy !== undefined ? { autonomy: patch.autonomy } : {}),
        ...(patch.concurrency !== undefined ? { concurrency: patch.concurrency } : {}),
        // Kept as a compatibility mirror, merged per role: dispatch routes on the
        // agent members staffing names and reads this only for a role nobody
        // staffed. Staffing below is what the routing now means.
        ...(routing !== undefined ? { routing } : {}),
        ...(patch.routing !== undefined ? { staffing: this.#staffFromRouting(workspace, patch.routing) } : {}),
        ...(patch.knowledge !== undefined
          ? { knowledge: { ...workspace.knowledge, ...patch.knowledge } }
          : {}),
        updatedAt: this.clock.now(),
      });
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
  #seedBuiltInRoles(workspaceId: WorkspaceId): void {
    const now = this.clock.now();
    for (const role of BUILT_IN_ROLES) {
      // `get` falls back to the global row, whose createdAt is not this
      // project's. Reading it here made every seeded role look edited
      // (createdAt !== updatedAt), so no later upgrade to the shipped role
      // would ever reach the project.
      const existing = this.roles.get(role.id, workspaceId);
      const createdAt = existing?.workspaceId === workspaceId ? existing.createdAt : now;
      this.roles.upsert({
        ...role,
        workspaceId,
        createdAt,
        updatedAt: createdAt,
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

  /**
   * Legacy routing, as a client that predates staffing sends it.
   *
   * Each role gets the agent migration 008 would have made for it - reused
   * when it exists, so saving the routing screen twice does not grow the team -
   * and the role is staffed to that agent only when nobody has staffed it yet.
   * A role someone deliberately staffed is never overwritten from a screen
   * that cannot show what it would be overwriting.
   */
  #staffFromRouting(workspace: Workspace, routing: Readonly<Record<string, readonly string[]>>): RoleStaffing {
    const staffing: Record<string, StaffingPatch> = { ...(workspace.staffing ?? {}) };
    const members = this.team.members.listByWorkspace(workspace.id, { includeRemoved: true });
    const owner = indexTeam(members).owners[0];
    // Without an owner no agent can be created; the stored routing still applies.
    if (owner === undefined) return staffing;

    for (const [roleId, profiles] of Object.entries(routing)) {
      const name = legacyAgentName(roleId);
      const existing = members.find((m) =>
        m.kind === 'agent' && m.status === 'active' && m.name === name
        && m.roleIds.length === 1 && m.roleIds[0] === roleId);
      let agent: Member | undefined = existing;
      if (existing !== undefined) {
        agent = this.team.members.update(existing.id, { runtimeProfileIds: [...profiles] });
      } else if (profiles.length > 0) {
        agent = this.team.members.create({
          id: ids.member(), workspaceId: workspace.id, kind: 'agent', personId: null, name, title: null,
          reportsTo: owner.id, access: null, oversight: 'delegate_owns', roleIds: [roleId],
          runtimeProfileIds: [...profiles], integrationIds: [], status: 'active',
        });
      }
      if (agent !== undefined && staffing[roleId] === undefined) staffing[roleId] = { assignees: [agent.id] };
    }
    return staffing;
  }

  /**
   * Routing as staffing says it is: a role's runtimes are those of the first
   * *active* agent it is staffed to, the one dispatch tries first. Roles with
   * no active staffed agent keep the stored routing, which is what dispatch
   * falls back to for them.
   */
  #routing(workspace: Workspace): Record<string, readonly string[]> {
    const team = indexTeam(this.team.members.listByWorkspace(workspace.id, { includeRemoved: true }));
    const derived: Record<string, readonly string[]> = { ...workspace.routing };
    for (const [roleId, patch] of Object.entries(workspace.staffing ?? {})) {
      const agent = (patch.assignees ?? []).map((a) => team.byId.get(a))
        .find((m) => m?.kind === 'agent' && isActiveMember(team, m.id));
      if (agent !== undefined) derived[roleId] = agent.runtimeProfileIds;
    }
    return derived;
  }

  #view(stored: Workspace): WorkspaceView {
    const workspace = { ...stored, routing: this.#routing(stored) };
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

/** The same name migration 008 gives the agent it makes from a role's routing. */
function legacyAgentName(roleId: string): string {
  return `${roleId.charAt(0).toUpperCase()}${roleId.slice(1)} agent`;
}
