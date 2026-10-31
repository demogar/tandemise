import type {
  MergeDecisionRepositoryPort, Mission, MissionRepositoryPort, PlanDecisionRepositoryPort, PullRequestPort, RepoRepositoryPort, TaskRepositoryPort,
} from '@tandemise/domain';
import { compileWorkflow, prTitle } from '@tandemise/domain';
import type { CommandExecutor } from '@tandemise/integrations-core';
import { TandemiseError, ids, slugify, type Clock, type MissionId, type Timestamp } from '@tandemise/shared';
import type { EventRecorder } from '../support/event-recorder.js';
import { laneWorkflows } from '../planning/defaults/lanes.js';
import { materializePlan } from '../planning/materialize.js';
import type { OutcomeRecorder } from './outcomes.js';

/**
 * Revert in one action (#53 §8.7): `git revert` of the merge commit on a fresh
 * `revert/<sha>` branch, as a mission whose only step is the ship step, so the
 * revert pull request goes through the same decision as any change. A revert
 * of a change Tandemise merged on its own may itself merge on its own under
 * `revertAutoMerge`; `never` rules still apply, so a migration revert asks.
 */
export interface ShipRevertDeps {
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly repositories: RepoRepositoryPort;
  readonly mergeDecisions: MergeDecisionRepositoryPort;
  readonly planDecisions: PlanDecisionRepositoryPort;
  readonly pullRequests: Pick<PullRequestPort, 'view'>;
  readonly exec: CommandExecutor | null;
  readonly credentialEnv?: () => Readonly<Record<string, string>>;
  readonly outcomes: () => Pick<OutcomeRecorder, 'reverted'> | undefined;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly wake: () => void;
  readonly tmpRoot: string;
}

export class ShipRevert {
  readonly #inFlight = new Set<string>();

  constructor(private readonly deps: ShipRevertDeps) {}

  async revert(decisionId: string, _by: string): Promise<Mission> {
    const decision = this.deps.mergeDecisions.get(decisionId);
    if (decision === undefined) throw TandemiseError.notFound('Merge decision', decisionId);
    if (decision.mergeSha === null) throw new TandemiseError('PRECONDITION_FAILED', 'This pull request was never merged, so there is nothing to revert.');
    const original = this.deps.missions.get(decision.missionId);
    const repository = original?.repositoryId == null ? undefined : this.deps.repositories.get(original.repositoryId);
    if (original === undefined || repository === undefined || this.deps.exec === null) {
      throw new TandemiseError('PRECONDITION_FAILED', 'The repository this was merged into isn\'t here any more.');
    }
    const merged = { ...decision, mergeSha: decision.mergeSha };
    // One revert per merge: a second press (or a double click) finds the first on its way.
    const already = this.deps.missions.list({ workspaceId: original.workspaceId })
      .find((m) => m.workflowInputs['revertOf'] === decision.id && m.status !== 'CANCELLED' && m.status !== 'FAILED');
    if (already !== undefined) throw new TandemiseError('CONFLICT', 'A revert of this merge is already on its way.', { details: { missionId: already.id } });
    if (this.#inFlight.has(decision.id)) throw new TandemiseError('CONFLICT', 'A revert of this merge is already on its way.');
    this.#inFlight.add(decision.id);
    try {
      return await this.#revert(merged, original, repository);
    } finally {
      this.#inFlight.delete(decision.id);
    }
  }

  async #revert(decision: NonNullable<ReturnType<MergeDecisionRepositoryPort['get']>> & { mergeSha: string }, original: Mission, repository: NonNullable<ReturnType<RepoRepositoryPort['get']>>): Promise<Mission> {
    const pr = await this.deps.pullRequests.view(repository.path, decision.repo, decision.prNumber);
    const branch = `revert/${decision.mergeSha.slice(0, 12)}`;
    const dir = `${this.deps.tmpRoot}/${slugify(branch)}-${Date.now()}`;
    const git = (args: readonly string[], cwd = repository.path, credentials = false) => this.deps.exec!.run({
      command: 'git', args, cwd, timeoutMs: 120_000,
      env: { GIT_TERMINAL_PROMPT: '0', ...(credentials ? this.deps.credentialEnv?.() ?? {} : {}) },
    });
    await git(['fetch', '--quiet', 'origin', pr.baseBranch], repository.path, true);
    const added = await git(['worktree', 'add', '-B', branch, dir, `origin/${pr.baseBranch}`]);
    if (added.exitCode !== 0) throw new TandemiseError('CONFLICT', `Couldn't start the revert branch: ${added.stderr.split('\n')[0]}`);
    try {
      const reverted = await git(['-c', 'user.name=Tandemise', '-c', 'user.email=ship@tandemise.local', '-c', 'commit.gpgsign=false', 'revert', '--no-edit', '-m', '1', decision.mergeSha], dir);
      const plain = reverted.exitCode === 0 ? reverted
        : await git(['-c', 'user.name=Tandemise', '-c', 'user.email=ship@tandemise.local', '-c', 'commit.gpgsign=false', 'revert', '--no-edit', decision.mergeSha], dir);
      if (plain.exitCode !== 0) {
        await git(['revert', '--abort'], dir);
        throw new TandemiseError('CONFLICT', `The merge can't be reverted cleanly: ${plain.stderr.split('\n')[0] ?? 'git revert failed'}`);
      }
    } finally {
      await git(['worktree', 'remove', '--force', dir]);
    }

    const title = `revert: ${pr.title}`;
    const id = ids.mission() as MissionId;
    const now = this.deps.clock.now() as Timestamp;
    const mission = this.deps.missions.create({
      id, workspaceId: original.workspaceId, repositoryId: original.repositoryId, title,
      goal: `Revert ${pr.url}, merged as ${decision.mergeSha}.`,
      workflowPreset: 'auto',
      workflowInputs: { revertOf: decision.id, shipBranch: branch, revertOfAuto: decision.mergedBy === 'tandemise' ? 'true' : 'false' },
      baseBranch: pr.baseBranch, createdBy: original.createdBy ?? null, laneRequest: null,
      ...(original.issueLinkId == null ? {} : { issueLinkId: original.issueLinkId }),
    });
    const ship = laneWorkflows({}).quick!.steps.find((s) => s.executor === 'ship')!;
    const compiled = compileWorkflow({ name: 'Revert', inputs: [], steps: [{ ...ship, dependsOn: [] }] }, {}, {});
    if (!compiled.ok) throw new TandemiseError('INTERNAL', 'The revert plan does not compile.');
    this.deps.tasks.replaceAll(id, materializePlan(compiled.value, id, this.deps.clock));
    const before = this.deps.planDecisions.latest(original.id);
    if (before !== undefined) {
      this.deps.planDecisions.create({ ...before, id: ids.planDecision(), missionId: id, lane: 'quick', laneBecause: 'a revert', workflowId: 'revert', modules: [], dropped: [], steps: [], approvals: [], skipped: [], tiebreak: null, lightenedByPerson: false, createdAt: now, profile: { ...before.profile, type: 'fix' } });
    }
    const started = this.deps.missions.update(id, { status: 'EXECUTING', statusReason: `Reverting ${prTitle({ type: 'fix' }, pr.title)}.`, startedAt: now });
    this.deps.recorder.record({ workspaceId: mission.workspaceId, missionId: id }, { type: 'mission.status', from: 'DRAFT', to: 'EXECUTING', reason: started.statusReason ?? '' });
    // The merge counts as reverted once the revert's pull request exists (the ship step records it then).
    this.deps.recorder.note({ workspaceId: original.workspaceId, missionId: original.id }, `Reverting it: ${title}.`);
    this.deps.recorder.invalidate('missions');
    this.deps.wake();
    return started;
  }
}
