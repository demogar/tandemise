import type { LoadedArtifact, Mission, MissionTask, Repository, RoleTemplate, Run, RunBrain } from '@tandemise/domain';
import { selectBrain } from '@tandemise/domain';
import type { ContextRequest } from '@tandemise/context';
import type { Clock, Logger } from '@tandemise/shared';
import { errorMessage } from '@tandemise/shared';
import type { TrialContext } from '../engine/task-executor.js';
import type { BrainService } from './brain-service.js';
import { BRAIN_RULES } from './layout.js';

export interface BrainAttemptInput {
  readonly task: MissionTask;
  readonly mission: Mission;
  readonly role: RoleTemplate;
  readonly repositories: readonly Repository[];
  readonly round: number;
  readonly previousRuns: readonly Run[];
  readonly trial: TrialContext | null;
  /** The dependency artifacts the prompt carries, for `paths` scopes. */
  readonly dependencies?: readonly LoadedArtifact[];
}

/**
 * What an attempt knows from the brain (#51 spec §10, §11). The executor asks
 * once per prompt and passes the result to the compiler, which stays pure.
 *
 * One commit per attempt: a run in the same round as an earlier run of this
 * task reads that run's commit, so a retry is not changed by a lesson that
 * arrived in between. Otherwise the commit is the brain's head after a pull,
 * when the last pull is stale.
 */
export class BrainContextSupply {
  constructor(
    private readonly brain: BrainService,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  async forAttempt(input: BrainAttemptInput): Promise<{ request: NonNullable<ContextRequest['brain']>; record: RunBrain } | undefined> {
    const { task, mission, trial } = input;
    if (trial !== null) {
      // A trial reads its frozen knowledge, or only a candidate's rules (spec §10).
      const rules = trial.brainRules;
      if (rules === undefined) return undefined;
      return {
        request: { sha: 'trial', rules, lessons: [], index: [] },
        record: { sha: 'trial', rules: rules.map((r) => r.path), loaded: [], indexed: 0, fetched: [], proposed: [] },
      };
    }
    const link = this.brain.linkOf(mission.workspaceId);
    if (link === undefined) return undefined;
    try {
      const sameRound = [...input.previousRuns].reverse().find((r) => (r.round ?? 1) === input.round && r.brain?.sha !== undefined && r.brain.sha !== 'trial');
      const sha = sameRound?.brain?.sha ?? (await this.brain.pin(mission.workspaceId));
      if (sha === null) return undefined;
      const repoNames = this.#repoNames(task, mission, input.repositories);
      const rulePaths = [`${BRAIN_RULES}/project.md`, ...repoNames.map((n) => `${BRAIN_RULES}/repo-${n}.md`), `${BRAIN_RULES}/role-${task.roleId}.md`];
      const rules: { path: string; text: string }[] = [];
      for (const path of rulePaths) {
        const text = await this.brain.readAt(mission.workspaceId, sha, path);
        if (text !== null && text.trim() !== '') rules.push({ path, text });
      }
      const memory = await this.brain.memoryAt(mission.workspaceId, sha);
      const files = (input.dependencies ?? []).flatMap((a) => [a.manifest.title, ...(a.manifest.handoff?.changed ?? []).map((c) => c.what)]);
      const selected = selectBrain(memory, { repos: repoNames, role: task.roleId, step: task.key, files }, this.clock.now());
      return {
        request: { sha, rules, lessons: selected.lessons, index: selected.index },
        record: {
          sha, rules: rules.map((r) => r.path), loaded: selected.lessons.map((l) => ({ id: l.id, net: l.net })),
          indexed: selected.index.length, fetched: [], proposed: [],
        },
      };
    } catch (e) {
      // The brain never blocks work (spec §4): the run goes ahead without it.
      this.log.warn('brain.context_failed', { taskId: task.id, error: errorMessage(e) });
      return undefined;
    }
  }

  /** The brain's names for the repositories this task touches. */
  #repoNames(task: MissionTask, mission: Mission, repositories: readonly Repository[]): string[] {
    const ids = new Set([task.repositoryId, mission.repositoryId].filter((x): x is NonNullable<typeof x> => x !== null && x !== undefined));
    return repositories.filter((r) => ids.has(r.id)).map((r) => r.name);
  }
}
