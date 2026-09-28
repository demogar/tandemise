import type {
  ArtifactRepositoryPort, ExecutionTargetRepositoryPort, Mission, MissionTask, RepoRepositoryPort, RoleRepositoryPort,
  TaskRepositoryPort,
} from '@tandemise/domain';
import { topologicalOrder } from '@tandemise/domain';
import type { ExecutionTarget, ExecutionTargetManager } from '@tandemise/execution-core';
import type { Clock } from '@tandemise/shared';
import { errorMessage, ids, slugify, summarize } from '@tandemise/shared';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import { asPlannedTasks, describeIssues, validateTaskGraph } from '../support/dag.js';
import { liveArtifacts } from '../support/lineage.js';

export interface MergedBranch {
  readonly taskKey: string;
  readonly branch: string;
  readonly merged: boolean;
  readonly conflictedPaths: readonly string[];
}

export interface IntegrationOutcome {
  readonly integrationBranch: string | null;
  readonly results: readonly MergedBranch[];
  /** Key of the conflict-resolution task this run inserted, if any. */
  readonly conflictTaskKey: string | null;
  readonly skippedReason: string | null;
}

/**
 * Merges each successful task branch into the mission's integration branch
 * (MVP.md §11.3).
 *
 * Merging happens in `topologicalOrder` so the result is deterministic and
 * reviewable: the same plan integrated twice produces the same history, and a
 * conflict is always between a task and the work it actually came after.
 *
 * A conflict is **never** auto-resolved. Resolving one requires knowing which
 * of two intents wins, which is precisely the judgement that produced the two
 * branches in the first place. Instead the merge is aborted and the conflict
 * becomes a development task with the conflicted paths enumerated - work, not a
 * guess.
 */
export class BranchIntegrationService {
  constructor(
    private readonly tasks: TaskRepositoryPort,
    private readonly repositories: RepoRepositoryPort,
    private readonly targets: ExecutionTargetRepositoryPort,
    private readonly roles: RoleRepositoryPort,
    private readonly targetManager: ExecutionTargetManager,
    private readonly recorder: EventRecorder,
    private readonly clock: Clock,
    private readonly artifacts: ArtifactRepositoryPort,
  ) {}

  async integrate(mission: Mission): Promise<IntegrationOutcome> {
    const none = (skippedReason: string): IntegrationOutcome =>
      ({ integrationBranch: mission.integrationBranch, results: [], conflictTaskKey: null, skippedReason });

    if (mission.repositoryId === null || mission.integrationBranch === null) {
      return none('The mission has no repository or no integration branch.');
    }
    const repository = this.repositories.get(mission.repositoryId);
    if (repository === undefined) return none('The mission repository no longer exists.');

    const missionTasks = this.tasks.listByMission(mission.id);
    const branches = this.#branchesToMerge(mission, missionTasks);
    if (branches.length < 2) {
      // One branch is not an integration; it is the branch. Merging it buys
      // nothing and costs a worktree.
      return none('Fewer than two task branches succeeded; nothing to integrate.');
    }

    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id };
    const target = await this.targetManager.provision({
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      taskId: null,
      kind: 'worktree',
      name: 'integration',
      repositoryPath: repository.path,
      branch: mission.integrationBranch,
      baseBranch: mission.baseBranch ?? repository.defaultBranch,
      missionSlug: slugify(mission.title),
    });

    try {
      const results: MergedBranch[] = [];
      for (const entry of branches) {
        results.push(await this.#merge(target, entry, scope));
      }
      const conflicted = results.filter((r) => !r.merged);
      const conflictTaskKey = conflicted.length === 0
        ? null
        : this.#planConflictResolution(mission, missionTasks, conflicted, scope);

      this.recorder.note(
        scope,
        `Integrated ${results.filter((r) => r.merged).length}/${results.length} task branches into `
        + `${mission.integrationBranch}.`,
        conflicted.length === 0 ? 'info' : 'warn',
      );
      return {
        integrationBranch: mission.integrationBranch,
        results,
        conflictTaskKey,
        skippedReason: null,
      };
    } finally {
      await target.dispose();
    }
  }

  /**
   * One branch per succeeded task, in plan order. A task's branch is the one
   * its newest live ChangeSet names, when it names one: a change handed back
   * from a pull request (spec A4) lands on the pull request's branch, not the
   * worktree the agent had been working in. Otherwise it is the task's
   * worktree, as the target rows record it; a retired one (a hand-back
   * replaced it) is not merged.
   *
   * A ChangeSet a run made names its target's branch, which for a `local`
   * target is whatever the checkout had out (often the base branch itself).
   * Only a run's worktree branch is merged, as before; the ChangeSet's own
   * branch is taken as it stands only when a person brought it in.
   */
  #branchesToMerge(
    mission: Mission,
    missionTasks: readonly MissionTask[],
  ): ReadonlyArray<{ taskKey: string; branch: string }> {
    const order = topologicalOrder(asPlannedTasks(missionTasks));
    const rank = new Map((order.ok ? order.value : missionTasks.map((t) => t.key)).map((k, i) => [k, i]));

    const worktrees = new Map<string, { branch: string; live: boolean }[]>();
    for (const record of this.targets.listByMission(mission.id)) {
      if (record.kind !== 'worktree' || record.branch === null || record.taskId === null) continue;
      worktrees.set(record.taskId, [...(worktrees.get(record.taskId) ?? []), { branch: record.branch, live: record.status !== 'RELEASED' }]);
    }

    const changeBranch = new Map<string, { branch: string; at: string }>();
    for (const change of liveArtifacts(this.artifacts, mission.id, 'ChangeSet')) {
      if (change.taskId === null) continue;
      const branch = change.sourceRefs.find((r) => r.kind === 'git.branch')?.value;
      if (branch === undefined || branch.length === 0) continue;
      const own = (worktrees.get(change.taskId) ?? []).some((w) => w.branch === branch);
      if (change.createdByRunId !== null && !own) continue;
      const known = changeBranch.get(change.taskId);
      if (known !== undefined && known.at >= change.createdAt) continue;
      changeBranch.set(change.taskId, { branch, at: change.createdAt });
    }

    const seen = new Set<string>();
    const entries: Array<{ taskKey: string; branch: string }> = [];
    for (const task of missionTasks) {
      if (task.status !== 'SUCCEEDED') continue;
      const fromChange = changeBranch.get(task.id)?.branch;
      const branches = fromChange !== undefined
        ? [fromChange]
        : (worktrees.get(task.id) ?? []).filter((w) => w.live).map((w) => w.branch);
      for (const branch of branches) {
        if (branch === mission.integrationBranch || seen.has(branch)) continue;
        seen.add(branch);
        entries.push({ taskKey: task.key, branch });
      }
    }
    return entries.sort((a, b) => (rank.get(a.taskKey) ?? 0) - (rank.get(b.taskKey) ?? 0));
  }

  async #merge(
    target: ExecutionTarget,
    entry: { taskKey: string; branch: string },
    scope: EventScope,
  ): Promise<MergedBranch> {
    try {
      const merge = await target.exec({
        command: 'git',
        args: [
          '-c', 'commit.gpgsign=false',
          'merge', '--no-ff',
          '--message', `Integrate ${entry.taskKey} (${entry.branch})`,
          entry.branch,
        ],
      });
      if (merge.exitCode === 0) {
        return { taskKey: entry.taskKey, branch: entry.branch, merged: true, conflictedPaths: [] };
      }

      const conflicted = await target.exec({
        command: 'git',
        args: ['diff', '--name-only', '--diff-filter=U'],
      });
      await target.exec({ command: 'git', args: ['merge', '--abort'] });

      const paths = conflicted.stdout.split('\n').map((p) => p.trim()).filter((p) => p.length > 0);
      this.recorder.note(
        scope,
        `Merging ${entry.branch} conflicted in ${paths.length} path(s): ${paths.slice(0, 10).join(', ')}`,
        'warn',
      );
      return { taskKey: entry.taskKey, branch: entry.branch, merged: false, conflictedPaths: paths };
    } catch (e) {
      this.recorder.note(scope, `Merging ${entry.branch} failed: ${errorMessage(e)}`, 'error');
      return { taskKey: entry.taskKey, branch: entry.branch, merged: false, conflictedPaths: [] };
    }
  }

  #planConflictResolution(
    mission: Mission,
    missionTasks: readonly MissionTask[],
    conflicted: readonly MergedBranch[],
    scope: EventScope,
  ): string | null {
    const cycle = missionTasks.filter((t) => t.key.startsWith('resolve_conflicts_')).length + 1;
    const key = `resolve_conflicts_${cycle}`;
    const template = missionTasks.find((t) => t.roleId === 'development') ?? missionTasks[0];
    if (template === undefined) return null;

    const task: MissionTask = {
      ...template,
      id: ids.task(),
      missionId: mission.id,
      key,
      title: `Resolve integration conflicts (${conflicted.length} branch(es))`,
      objective: conflictObjective(mission, conflicted),
      roleId: 'development',
      dependsOn: conflicted.map((c) => c.taskKey),
      expectedOutputs: ['ChangeSet'],
      completionGate: 'artifact.ChangeSet.exists',
      status: 'PENDING',
      statusReason: null,
      attempts: 0,
      remediatesTaskId: null,
      orderHint: missionTasks.length + cycle,
      createdAt: this.clock.now(),
      updatedAt: this.clock.now(),
      startedAt: null,
      finishedAt: null,
    };

    const validated = validateTaskGraph([...missionTasks, task], this.roles.list(mission.workspaceId));
    if (!validated.ok) {
      this.recorder.note(
        scope,
        `Could not insert a conflict-resolution task: ${describeIssues(validated.error)}`,
        'error',
      );
      return null;
    }
    this.tasks.add(task);
    this.recorder.invalidate('tasks', mission.id);
    return key;
  }
}

function conflictObjective(mission: Mission, conflicted: readonly MergedBranch[]): string {
  return [
    `Resolve the merge conflicts that stopped these branches from integrating into`,
    `${mission.integrationBranch}. Merge each one in turn and resolve by hand:`,
    '',
    ...conflicted.map((c) => [
      `- ${c.branch} (from task ${c.taskKey})`,
      ...c.conflictedPaths.map((p) => `    ${p}`),
    ].join('\n')),
    '',
    'Preserve the intent of both sides. Where two changes genuinely cannot coexist, keep the one the',
    'mission goal requires and say in the ChangeSet what you dropped and why:',
    '',
    summarize(mission.goal, 500),
    '',
    'Run the repository checks after every resolution, not only at the end.',
  ].join('\n');
}
