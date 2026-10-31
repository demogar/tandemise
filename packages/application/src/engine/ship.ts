import type {
  Mission, MissionCriteriaRepositoryPort, MissionTask, PlanDecisionRepositoryPort, PullRequestPort, PullRequestRef,
  RepoRepositoryPort, Repository, TaskRepositoryPort,
} from '@tandemise/domain';
import { githubRepoFromRemote, isTrialMission, prBody, prTitle, profileLine } from '@tandemise/domain';
import type { CommandExecutor } from '@tandemise/integrations-core';
import { errorMessage, type Clock, type Logger } from '@tandemise/shared';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import type { BranchIntegrationService } from './branch-integration.js';

/**
 * The ship step (#53 §8.1): the daemon-owned last step of every code plan. No
 * agent runs in it and nobody holds it. In order, each transition persisted
 * before its side effect: integrate the task branches (a conflict becomes a
 * `resolve_conflicts_N` step before any pull request exists), push, and open a
 * non-draft pull request from the daemon, titled from the profile.
 */
export type ShipOutcome =
  | { readonly kind: 'opened'; readonly prs: readonly PullRequestRef[] }
  | { readonly kind: 'conflict'; readonly taskKey: string }
  /** The measured change called for more steps (#53 §5.4); the ship step waits behind them. */
  | { readonly kind: 'escalated'; readonly added: readonly string[] }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'cancelled' };

const PUSH_TIMEOUT_MS = 120_000;

export interface ShipDeps {
  readonly tasks: TaskRepositoryPort;
  readonly repositories: RepoRepositoryPort;
  readonly integration: BranchIntegrationService;
  readonly pullRequests: PullRequestPort;
  readonly exec: CommandExecutor | null;
  readonly credentialEnv?: () => Readonly<Record<string, string>>;
  readonly planDecisions: PlanDecisionRepositoryPort;
  readonly criteria: Pick<MissionCriteriaRepositoryPort, 'listActive'>;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
  /** Re-profiles from the changed paths and adds steps (#53 §5.4); the keys it added. */
  readonly escalate?: (mission: Mission, paths: readonly string[]) => Promise<readonly string[]>;
}

export class ShipService {
  constructor(protected readonly deps: ShipDeps) {}

  async run(mission: Mission, task: MissionTask, signal: AbortSignal): Promise<ShipOutcome> {
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id };
    if (isTrialMission(mission)) return { kind: 'skipped', reason: 'An eval trial never opens a pull request.' };
    const repository = mission.repositoryId === null ? undefined : this.deps.repositories.get(mission.repositoryId);
    if (repository === undefined) return { kind: 'skipped', reason: 'This mission has no repository, so there is no pull request to open.' };

    // Measured before anything leaves this machine: a change that touched more
    // than its plan expected gets its steps first, then ships (#53 §5.4).
    const early = this.#codeBranch(mission);
    if (early !== null && this.deps.escalate !== undefined) {
      const base = mission.baseBranch ?? repository.defaultBranch;
      const diff = await this.#git(repository, ['diff', '--name-only', `${base}...${early}`], false);
      const paths = diff.exitCode === 0 ? diff.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0) : [];
      try {
        const added = await this.deps.escalate(mission, paths);
        if (added.length > 0) {
          const current = this.deps.tasks.get(task.id) ?? task;
          this.deps.tasks.update(task.id, { dependsOn: [...new Set([...current.dependsOn, ...added])] });
          return { kind: 'escalated', added };
        }
      } catch (e) {
        this.deps.log.warn('ship.escalate_failed', { missionId: mission.id, error: errorMessage(e) });
      }
    }

    const integrated = await this.deps.integration.integrate(mission);
    if (integrated.conflictTaskKey !== null) {
      // The ship step waits behind the conflict's resolution, then integrates again.
      const current = this.deps.tasks.get(task.id) ?? task;
      this.deps.tasks.update(task.id, { dependsOn: [...new Set([...current.dependsOn, integrated.conflictTaskKey])] });
      return { kind: 'conflict', taskKey: integrated.conflictTaskKey };
    }
    if (signal.aborted) return { kind: 'cancelled' };
    const branch = integrated.results.length >= 2 && integrated.integrationBranch !== null
      ? integrated.integrationBranch
      : this.#codeBranch(mission);
    if (branch === null) return { kind: 'skipped', reason: 'No step changed any code, so there is nothing to ship.' };

    const repo = githubRepoFromRemote(repository.remoteUrl);
    if (repo === null) {
      return { kind: 'skipped', reason: `There is no GitHub remote, so there is no pull request to open; the work is on branch ${branch}.` };
    }

    const pushed = await this.#git(repository, ['push', 'origin', `${branch}:refs/heads/${branch}`], true);
    if (pushed.exitCode !== 0) return { kind: 'blocked', reason: `Couldn't push ${branch}: ${firstLine(pushed.stderr || pushed.stdout)}` };
    if (signal.aborted) return { kind: 'cancelled' };

    let pr: PullRequestRef & { created: boolean };
    try {
      pr = await this.deps.pullRequests.open({
        cwd: repository.path,
        repo,
        head: branch,
        base: mission.baseBranch ?? repository.defaultBranch,
        title: this.title(mission),
        body: this.body(mission),
      });
    } catch (e) {
      return { kind: 'blocked', reason: `Couldn't open the pull request: ${errorMessage(e)}` };
    }
    this.deps.recorder.record(scope, { type: 'ship.pr_opened', repo, number: pr.number, url: pr.url, headSha: pr.headSha });
    if (pr.created) this.deps.recorder.note(scope, `Opened the pull request ${pr.url}.`);
    return { kind: 'opened', prs: [pr] };
  }

  /** `<type>: <title>` from the plan decision's profile. */
  title(mission: Mission): string {
    const decision = this.deps.planDecisions.latest(mission.id);
    return prTitle({ type: decision?.profile.type ?? 'chore' }, mission.title);
  }

  /** The tracker link, the Done-when table and the plan's why. No agent-written text. */
  body(mission: Mission): string {
    const decision = this.deps.planDecisions.latest(mission.id);
    const why = decision === undefined ? [] : [
      `${profileLine(decision.profile)}; ${decision.lane} lane.`,
      ...decision.modules.map((m) => `Added by the ${m} rule.`),
      ...decision.skipped,
    ];
    const criteria = this.deps.criteria.listActive(mission.id)
      .filter((c) => c.source !== 'spec' && c.status === 'accepted')
      .map((c) => ({ key: c.key, statement: c.statement, verified: c.source === 'implicit' ? 'Not independently verified' : 'See the QA report' }));
    return prBody({ link: null, criteria, why, missionId: mission.id });
  }

  /** The code step's branch: an implement or conflict step's, else the first that succeeded. */
  #codeBranch(mission: Mission): string | null {
    const branches = this.deps.integration.branchesFor(mission);
    const tasks = this.deps.tasks.listByMission(mission.id);
    const code = branches.find((b) => {
      const t = tasks.find((x) => x.key === b.taskKey);
      return t !== undefined && (t.stepClass === 'implement' || t.stepClass === 'resolve_conflicts' || t.roleId === 'development');
    });
    return (code ?? branches[0])?.branch ?? null;
  }

  protected async git(repository: Repository, args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.#git(repository, args, false);
  }

  async #git(repository: Repository, args: readonly string[], credentials: boolean): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (this.deps.exec === null) return { exitCode: 1, stdout: '', stderr: 'no git runner here' };
    return this.deps.exec.run({
      command: 'git',
      args,
      cwd: repository.path,
      timeoutMs: PUSH_TIMEOUT_MS,
      // A remote that asks for a password has no one to ask here; it fails instead of hanging.
      env: { GIT_TERMINAL_PROMPT: '0', ...(credentials ? this.deps.credentialEnv?.() ?? {} : {}) },
    });
  }
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? 'git failed';
}
