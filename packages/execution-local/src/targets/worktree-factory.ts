import { readdir, realpath, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  TandemiseError,
  ids,
  slugify,
  systemClock,
  type Clock,
  type Logger,
  type MissionId,
} from '@tandemise/shared';
import type { ExecutionTargetRecord, TargetKind } from '@tandemise/domain';
import type {
  ExecutionTarget,
  ExecutionTargetFactory,
  ProcessSupervisor,
  ProvisionRequest,
  ReleaseOptions,
  ReleaseOutcome,
  TargetCapability,
} from '@tandemise/execution-core';
import type { GitService } from '../git/git-service.js';
import type { WorkspaceProvisioner } from '../workspace-provisioner.js';
import { DirectoryExecutionTarget } from './directory-target.js';

const CAPABILITIES: readonly TargetCapability[] = ['exec', 'filesystem', 'git', 'isolated-workspace'];

export interface WorktreeTargetDeps {
  readonly git: GitService;
  readonly supervisor: ProcessSupervisor;
  readonly provisioner: WorkspaceProvisioner;
  readonly log: Logger;
  readonly clock?: Clock;
}

/**
 * One git worktree and branch per code-writing task (MVP.md §11.2).
 *
 * Provisioning is idempotent on purpose. The daemon can die between creating a
 * worktree and recording it, so re-provisioning must converge on the existing
 * tree rather than failing or creating a second one - that is the difference
 * between a recoverable crash and a manual cleanup.
 */
export class WorktreeTargetFactory implements ExecutionTargetFactory {
  readonly id = 'worktree';
  readonly displayName = 'Git worktree';
  readonly kind: TargetKind = 'worktree';
  readonly provides = [...CAPABILITIES];

  readonly #clock: Clock;

  constructor(private readonly deps: WorktreeTargetDeps) {
    this.#clock = deps.clock ?? systemClock;
  }

  /**
   * Short, stable suffix from a task id. The full branded id is long and its
   * prefix is constant, so the tail carries the entropy.
   */
  static shortId(taskId: string): string {
    return taskId.slice(-8);
  }

  async provision(request: ProvisionRequest): Promise<ExecutionTarget> {
    const missionId = this.#requireMission(request);
    const { git, log } = this.deps;
    const repositoryPath = resolve(request.repositoryPath);

    // The slug carries the task id, not just the name. Two tasks called
    // "implement login" and "Implement Login!" slugify identically, and without
    // the id the second would silently adopt the first's worktree and branch -
    // exactly the concurrent-write collision MVP.md §11.2 exists to prevent.
    // The id is also what lets the reuse path below tell a crashed run of *this*
    // task apart from a live run of a different one.
    const slug = request.taskId ? `${slugify(request.name)}-${WorktreeTargetFactory.shortId(request.taskId)}` : slugify(request.name);
    const missionSlug = request.missionSlug ?? slugify(missionId);
    const branch = request.branch ?? `tandemise/${missionSlug}/${slug}`;
    const base = request.baseBranch ?? (await git.defaultBranch(repositoryPath));

    await this.deps.provisioner.ensureMission(request.workspaceId, missionId);
    const directory = this.deps.provisioner.paths.worktree(request.workspaceId, missionId, slug);

    // A crash can leave a registration pointing at a directory that is gone;
    // git refuses to reuse the path until the stale entry is pruned.
    await git.pruneWorktrees(repositoryPath);
    const existing = await this.#findWorktree(repositoryPath, directory);

    if (existing) {
      if (existing.branch === null) {
        // A detached HEAD has no branch to commit onto, so release()'s salvage
        // commit would land unreachable and then be dropped by `worktree
        // remove` - silently losing the worker's uncommitted work. Refuse, and
        // let a human decide, rather than reuse a tree we cannot safely release.
        throw new TandemiseError('CONFLICT',
          `Worktree '${directory}' has a detached HEAD; refusing to reuse it because work committed there would be unreachable.`,
          { details: { directory, expected: branch } });
      }
      if (existing.branch !== branch) {
        throw new TandemiseError('CONFLICT', `Worktree '${directory}' already holds branch '${existing.branch}', not '${branch}'`, {
          details: { directory, expected: branch, actual: existing.branch },
        });
      }
      log.info('worktree.reused', { directory, branch });
    } else {
      await this.#clearEmptyDirectory(directory);
      const createBranch = !(await git.branchExists(repositoryPath, branch));
      await git.addWorktree(repositoryPath, directory, branch, base, { createBranch });
      log.info('worktree.created', { directory, branch, base, createBranch });
    }

    const baseCommit = await git.revParse(repositoryPath, base);
    const record: ExecutionTargetRecord = {
      id: request.id ?? ids.executionTarget(),
      workspaceId: request.workspaceId,
      missionId,
      taskId: request.taskId,
      kind: 'worktree',
      name: request.name,
      workingDirectory: directory,
      branch,
      baseBranch: base,
      status: 'READY',
      detail: baseCommit ? `base ${baseCommit}` : null,
      createdAt: this.#clock.now(),
      releasedAt: null,
    };
    return new DirectoryExecutionTarget({
      record,
      supervisor: this.deps.supervisor,
      log: this.deps.log,
      capabilities: CAPABILITIES,
    });
  }

  /**
   * Removes the worktree - but never at the cost of work. A dirty tree is
   * either committed to its own branch (when the caller supplies an identity to
   * attribute it to) or left exactly where it is with the reason reported.
   */
  async release(target: ExecutionTargetRecord, options: ReleaseOptions = {}): Promise<ReleaseOutcome> {
    const { git, log } = this.deps;
    const directory = target.workingDirectory;
    const outcome = (patch: Partial<ReleaseOutcome>): ReleaseOutcome => ({
      targetId: target.id,
      released: true,
      workingDirectory: directory,
      retainedReason: null,
      commit: null,
      ...patch,
    });

    if (!(await exists(directory))) return outcome({});

    const repositoryPath = await git.mainWorktreePath(directory);
    let commit: string | null = null;

    if (await git.hasUncommittedChanges(directory)) {
      const changed = await git.listChangedFiles(directory);
      if (options.commitLeftovers) {
        const message = options.commitMessage ?? `chore(tandemise): salvage work from ${target.name}`;
        commit = (await git.commitAll(directory, message, options.commitLeftovers)).hash;
        log.info('worktree.salvaged', { directory, commit: commit ?? undefined, files: changed.length });
      } else if (!options.force) {
        const retainedReason = `${changed.length} uncommitted path(s) on branch ${target.branch ?? 'unknown'}`;
        log.warn('worktree.retained', { directory, retainedReason, files: changed.slice(0, 20) });
        return outcome({ released: false, retainedReason });
      }
    }

    await git.removeWorktree(repositoryPath, directory, options.force ?? false);
    await git.pruneWorktrees(repositoryPath);
    log.info('worktree.removed', { directory, branch: target.branch ?? undefined });
    return outcome({ commit });
  }

  #requireMission(request: ProvisionRequest): MissionId {
    if (!request.missionId) {
      throw TandemiseError.validation('A worktree target requires a missionId: worktrees live under the mission', {
        name: request.name,
      });
    }
    return request.missionId;
  }

  async #findWorktree(repositoryPath: string, directory: string): Promise<{ branch: string | null } | undefined> {
    const wanted = await canonical(directory);
    for (const entry of await this.deps.git.listWorktrees(repositoryPath)) {
      if ((await canonical(entry.path)) === wanted) return entry;
    }
    return undefined;
  }

  /**
   * `git worktree add` refuses a non-empty directory. An empty one is the
   * residue of `ensureMission` or a half-finished provision and is safe to drop;
   * a non-empty unregistered directory is someone else's data and is not.
   */
  async #clearEmptyDirectory(directory: string): Promise<void> {
    if (!(await exists(directory))) return;
    const entries = await readdir(directory);
    if (entries.length > 0) {
      throw new TandemiseError('CONFLICT', `'${directory}' already exists and is not a registered worktree`, {
        details: { directory, entries: entries.slice(0, 10) },
      });
    }
    await rm(directory, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** git reports resolved paths; on macOS `/tmp/x` and `/private/tmp/x` are one. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}
