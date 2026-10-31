import {
  BACKTEST_WINDOW_DAYS, backtest, backtestSentence, isPolicyError, mergePolicySchema, parseMergePolicy,
  type BacktestResult, type DecisionRepositoryPort, type MemberRepositoryPort, type MergeDecisionRepositoryPort, type MergePolicy,
  type OutcomeRepositoryPort, type TaskRepositoryPort, type WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { TandemiseError, ids, type Clock, type WorkspaceId } from '@tandemise/shared';
import type { FactoryConfigSourcePort } from '../ports.js';
import type { PlannerService } from '../planning/planner-service.js';
import { SHIPPED_MERGE } from '../planning/defaults/merge.js';
import type { EventRecorder } from '../support/event-recorder.js';
import { actorFor, type Caller } from '../support/identity.js';

/**
 * Project settings → Merge (#53 §8.4): the merge policy, edited only by a
 * person and written to the project's repository. Turning auto-merge on shows
 * the backtest first and records a Decision: the standing, explicit approval
 * every auto-merge cites. Stop auto-merging writes it off and re-decides every
 * pull request waiting in a ship step, which then asks.
 */
export interface MergePolicyServiceDeps {
  readonly planner: PlannerService;
  readonly factorySource: Pick<FactoryConfigSourcePort, 'write'>;
  readonly workspaces: WorkspaceRepositoryPort;
  readonly mergeDecisions: MergeDecisionRepositoryPort;
  readonly outcomes: OutcomeRepositoryPort;
  readonly decisions: DecisionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly members: MemberRepositoryPort;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly wake: () => void;
}

export const ONLY_A_PERSON = 'Only a person can change the merge policy.';

export interface MergePolicyView {
  readonly policy: MergePolicy;
  readonly origin: 'project' | 'home' | 'shipped';
  readonly path: string | null;
  readonly error: string | null;
}

export class MergePolicyService {
  constructor(private readonly deps: MergePolicyServiceDeps) {}

  async get(workspaceId: WorkspaceId): Promise<MergePolicyView> {
    const config = await this.deps.planner.config(workspaceId);
    const error = isPolicyError(config.merge) ? config.merge.error : null;
    return {
      policy: isPolicyError(config.merge) ? mergePolicySchema.parse(SHIPPED_MERGE) : config.merge,
      origin: config.origins.merge,
      path: config.paths.merge,
      error,
    };
  }

  async backtest(workspaceId: WorkspaceId, candidateRaw: unknown): Promise<BacktestResult & { readonly sentence: string }> {
    const candidate = this.#parse(candidateRaw);
    const current = (await this.get(workspaceId)).policy;
    const since = new Date(this.deps.clock.epochMs() - BACKTEST_WINDOW_DAYS * 86_400_000).toISOString();
    const rows = this.deps.mergeDecisions.listByWorkspace(workspaceId, since);
    const outcomes = this.deps.outcomes.listByWorkspace(workspaceId, since);
    const result = backtest(rows, current, candidate, outcomes);
    return { ...result, sentence: backtestSentence(result, outcomes, rows, candidate) };
  }

  /** A person's edit. Off → on records a Decision with the backtest as its rationale. */
  async update(workspaceId: WorkspaceId, raw: unknown, caller: Caller & { readonly runtime?: boolean }): Promise<MergePolicyView> {
    const { actorId } = this.#person(workspaceId, caller);
    const policy = this.#parse(raw);
    const before = await this.get(workspaceId);
    const repository = this.deps.planner.repositories(workspaceId)[0];
    if (repository === undefined) throw new TandemiseError('PRECONDITION_FAILED', 'This project has no repository to write the merge policy into.');
    const turningOn = before.policy.autoMerge === 'off' && policy.autoMerge === 'on';
    const tested = turningOn ? await this.backtest(workspaceId, policy) : null;
    await this.deps.factorySource.write('merge', repository.path, policy);
    if (turningOn) {
      const workspace = this.deps.workspaces.get(workspaceId);
      const now = this.deps.clock.now();
      this.deps.decisions.create({
        id: ids.decision(), workspaceId, missionId: null,
        title: `Auto-merge low-risk pull requests in ${workspace?.name ?? 'this project'}`,
        context: 'The factory decides each pull request\'s merge from measured facts and this project\'s merge policy (#53).',
        decision: `Tandemise merges a pull request on its own when CI is green on its head commit and its risk score is at most ${policy.autoMergeAtMost}; everything else asks.`,
        rationale: tested?.sentence ?? 'Turned on by a person.',
        alternatives: [], consequences: ['Every auto-merge cites this decision and the policy\'s commit.'],
        status: 'accepted', owner: actorId, relatedArtifacts: [], supersedes: null, createdAt: now, decidedAt: now,
      });
      this.deps.recorder.invalidate('decisions');
    }
    this.deps.recorder.invalidate('workspaces');
    if (policy.autoMerge === 'off') this.#redecideWaiting(workspaceId);
    return this.get(workspaceId);
  }

  /** The kill switch: auto-merge off, and every waiting pull request decided again (so it asks). */
  async stop(workspaceId: WorkspaceId, caller: Caller & { readonly runtime?: boolean }): Promise<MergePolicyView> {
    const current = (await this.get(workspaceId)).policy;
    return this.update(workspaceId, { ...current, autoMerge: 'off' }, caller);
  }

  #redecideWaiting(workspaceId: WorkspaceId): void {
    const waiting = this.deps.tasks.listByStatus(['AWAITING_APPROVAL', 'AWAITING_EXTERNAL', 'RUNNING']).filter((t) => t.executor === 'ship');
    for (const task of waiting) {
      const latest = this.deps.mergeDecisions.listByMission(task.missionId).at(-1);
      if (latest === undefined || latest.workspaceId !== workspaceId || latest.voidedAt !== null || latest.mergedAt !== null) continue;
      // Voided, the ship step decides again on its next look, under the policy now on disk.
      this.deps.mergeDecisions.update(latest.id, { voidedAt: this.deps.clock.now() });
    }
    this.deps.wake();
  }

  #person(workspaceId: WorkspaceId, caller: Caller & { readonly runtime?: boolean }): { actorId: string } {
    if (caller.runtime === true) throw new TandemiseError('PRECONDITION_FAILED', ONLY_A_PERSON);
    const { actorId } = actorFor(this.deps, workspaceId, caller);
    const member = this.deps.members.get(actorId as never);
    if (member !== undefined && member.kind !== 'person') throw new TandemiseError('PRECONDITION_FAILED', ONLY_A_PERSON);
    return { actorId };
  }

  #parse(raw: unknown): MergePolicy {
    const parsed = parseMergePolicy(raw);
    if (isPolicyError(parsed)) throw TandemiseError.validation(`That merge policy can't be used: ${parsed.error}`, { error: parsed.error });
    return parsed;
  }
}
