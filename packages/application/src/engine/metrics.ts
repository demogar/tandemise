import type {
  ApprovalRepositoryPort, ArtifactRepositoryPort, EvaluationRepositoryPort, EventRepositoryPort,
  Evaluation, Mission, Run, RunRepositoryPort, TaskRepositoryPort, Workspace,
} from '@tandemise/domain';
import { blockingFindings } from '@tandemise/domain';
import type { MissionMetrics, ModelUsageView } from '@tandemise/api-contract';
import type { Clock } from '@tandemise/shared';

/**
 * Mission metrics (MVP.md §22.2).
 *
 * The governing rule is stated in the view model and enforced here: **a value
 * the runtime never reported stays `null`, never `0`.** A subscription-based
 * runtime exposes no trustworthy per-run cost, and rendering "$0.00" would be a
 * fabricated measurement rather than a missing one. The same applies to tokens.
 *
 * Everything else is counted from the durable record - runs, events, approvals,
 * evaluations - rather than accumulated in memory, so metrics survive a restart
 * and agree with what the timeline shows.
 */
export class MetricsService {
  constructor(
    private readonly tasks: TaskRepositoryPort,
    private readonly runs: RunRepositoryPort,
    private readonly events: EventRepositoryPort,
    private readonly approvals: ApprovalRepositoryPort,
    private readonly artifacts: ArtifactRepositoryPort,
    private readonly evaluations: EvaluationRepositoryPort,
    private readonly clock: Clock,
  ) {}

  compute(mission: Mission, workspace: Workspace | undefined): MissionMetrics {
    const tasks = this.tasks.listByMission(mission.id);
    const runs = this.runs.listByMission(mission.id);
    const now = this.clock.now();

    let runtimeActiveMs = 0;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let costUsd: number | null = null;
    let failures = 0;

    for (const run of runs) {
      runtimeActiveMs += Date.parse(run.finishedAt ?? now) - Date.parse(run.startedAt);
      if (run.status === 'FAILED') failures += 1;
      const usage = run.usage;
      if (usage === null) continue;
      if (usage.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + usage.inputTokens;
      if (usage.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + usage.outputTokens;
      if (usage.costUsd !== undefined && usage.costUsd !== null) costUsd = (costUsd ?? 0) + usage.costUsd;
    }

    let humanWaitMs = 0;
    for (const approval of this.approvals.list({ missionId: mission.id })) {
      humanWaitMs += Date.parse(approval.decidedAt ?? now) - Date.parse(approval.createdAt);
    }

    const filesChanged = new Set<string>();
    for (const record of this.events.listByMission(mission.id)) {
      if (record.body.type === 'file.changed') filesChanged.add(record.body.path);
    }

    const commits = new Set<string>();
    for (const artifact of this.artifacts.listByMission(mission.id)) {
      for (const ref of artifact.sourceRefs) {
        if (ref.kind === 'git.commit') commits.add(ref.value);
      }
    }

    let reviewFindings = 0;
    let qaDefects = 0;
    for (const task of tasks) {
      for (const evaluation of this.evaluations.listEvaluations(task.id)) {
        if (evaluation.evaluatorRoleId === 'qa') qaDefects += blockingFindings(evaluation).length;
        else reviewFindings += countFindings(evaluation);
      }
    }

    return {
      wallClockMs: mission.startedAt === null
        ? 0
        : Date.parse(mission.completedAt ?? now) - Date.parse(mission.startedAt),
      runtimeActiveMs,
      humanWaitMs,
      retries: tasks.reduce((sum, t) => sum + Math.max(0, t.attempts - 1), 0),
      failures,
      filesChanged: filesChanged.size,
      commits: commits.size,
      reviewFindings,
      qaDefects,
      inputTokens,
      outputTokens,
      costUsd,
      runtimeFallbacks: this.#countFallbacks(mission, workspace, runs),
      byModel: usageByModel(runs, now),
    };
  }

  /**
   * A fallback is a run that used a runtime other than the first choice its
   * role's routing policy named. Counting it from the data rather than from a
   * flag set at dispatch time means the number stays right after a restart.
   */
  #countFallbacks(
    mission: Mission,
    workspace: Workspace | undefined,
    runs: readonly import('@tandemise/domain').Run[],
  ): number {
    if (workspace === undefined) return 0;
    let fallbacks = 0;
    for (const run of runs) {
      const preferred = workspace.routing[run.roleId]?.[0];
      if (preferred !== undefined && preferred !== run.runtimeProfileId) fallbacks += 1;
    }
    return fallbacks;
  }
}

/**
 * Usage grouped by the model each run was given (P12). Runs from before P12
 * have no reason recorded and are grouped as "not recorded", apart from runs
 * that really ran on the runtime's default.
 */
export function usageByModel(runs: readonly Run[], now: string): ModelUsageView[] {
  const groups = new Map<string, { model: string | null; label: string; runs: number; agentMs: number; tokens: number | null; costUsd: number | null }>();
  for (const run of runs) {
    const recorded = run.modelReason !== null && run.modelReason !== undefined;
    const model = run.model ?? null;
    const label = model ?? (recorded ? 'runtime default' : 'not recorded');
    const key = model === null ? `~${label}` : `=${model}`;
    const group = groups.get(key) ?? { model, label, runs: 0, agentMs: 0, tokens: null, costUsd: null };
    group.runs += 1;
    group.agentMs += run.usage?.wallTimeMs ?? Math.max(0, Date.parse(run.finishedAt ?? now) - Date.parse(run.startedAt));
    const used = (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0);
    if (run.usage?.inputTokens !== undefined || run.usage?.outputTokens !== undefined) group.tokens = (group.tokens ?? 0) + used;
    if (run.usage?.costUsd !== undefined && run.usage.costUsd !== null) group.costUsd = (group.costUsd ?? 0) + run.usage.costUsd;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.runs - a.runs || a.label.localeCompare(b.label));
}

/** Review findings worth surfacing: anything a human would have to act on. */
function countFindings(evaluation: Evaluation): number {
  return evaluation.findings.filter((f) => f.severity === 'blocking' || f.severity === 'major').length;
}
