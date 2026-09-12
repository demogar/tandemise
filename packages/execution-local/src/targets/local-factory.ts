import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  TandemiseError,
  ids,
  systemClock,
  type Clock,
  type Logger,
} from '@tandemise/shared';
import type { ExecutionTargetRecord, TargetKind } from '@tandemise/domain';
import type {
  ExecutionTarget,
  ExecutionTargetFactory,
  ProcessSupervisor,
  ProvisionRequest,
  ReleaseOutcome,
  TargetCapability,
} from '@tandemise/execution-core';
import type { GitService } from '../git/git-service.js';
import { DirectoryExecutionTarget } from './directory-target.js';

const CAPABILITIES: readonly TargetCapability[] = ['exec', 'filesystem', 'git'];

export interface LocalTargetDeps {
  readonly supervisor: ProcessSupervisor;
  readonly git: GitService;
  readonly log: Logger;
  readonly clock?: Clock;
}

/**
 * The repository itself, unisolated (MVP.md §11.1).
 *
 * Appropriate for roles that only read - reviewers, analysts, context
 * gatherers. A code-writing role must not be given one: concurrent writes to
 * the user's own checkout are exactly what worktree isolation exists to prevent.
 */
export class LocalTargetFactory implements ExecutionTargetFactory {
  readonly id = 'local';
  readonly displayName = 'Local repository directory';
  readonly kind: TargetKind = 'local';
  readonly provides = [...CAPABILITIES];

  readonly #clock: Clock;

  constructor(private readonly deps: LocalTargetDeps) {
    this.#clock = deps.clock ?? systemClock;
  }

  async provision(request: ProvisionRequest): Promise<ExecutionTarget> {
    const directory = resolve(request.repositoryPath);
    await assertDirectory(directory);
    const branch = await this.deps.git.currentBranch(directory);
    const record: ExecutionTargetRecord = {
      id: request.id ?? ids.executionTarget(),
      workspaceId: request.workspaceId,
      missionId: request.missionId,
      taskId: request.taskId,
      kind: 'local',
      name: request.name,
      workingDirectory: directory,
      branch,
      baseBranch: null,
      status: 'READY',
      detail: null,
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

  async release(target: ExecutionTargetRecord): Promise<ReleaseOutcome> {
    // Releasing a local target is bookkeeping only. The directory is the user's
    // own checkout; Tandemise never deletes or cleans it.
    return {
      targetId: target.id,
      released: true,
      workingDirectory: target.workingDirectory,
      retainedReason: null,
      commit: null,
    };
  }
}

async function assertDirectory(path: string): Promise<void> {
  try {
    if ((await stat(path)).isDirectory()) return;
  } catch (cause) {
    throw new TandemiseError('TARGET_UNAVAILABLE', `Repository path '${path}' is not accessible`, {
      details: { path },
      cause,
    });
  }
  throw new TandemiseError('TARGET_UNAVAILABLE', `Repository path '${path}' is not a directory`, {
    details: { path },
  });
}
