import type {
  ApprovalRepositoryPort, ArtifactRepositoryPort, DecisionRepositoryPort,
  EvaluationRepositoryPort, EventRepositoryPort, ExecutionTargetRecord,
  ExecutionTargetRepositoryPort, Mission, MissionRepositoryPort, MissionStatus, MissionTask,
  PlanValidationIssue, RepoRepositoryPort, RoleRepositoryPort, RunEventRecord, RunRepositoryPort,
  RuntimeProfileRepositoryPort, TaskRepositoryPort, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { planLevels } from '@tandemise/domain';
import type {
  HomeView, MissionDetail, MissionSummary, RuntimeView, TaskView,
} from '@tandemise/api-contract';
import type { MissionId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId } from '@tandemise/shared';
import type { ProjectionService, RuntimeService } from '../services.js';
import type { GateService } from '../engine/gates.js';
import type { MetricsService } from '../engine/metrics.js';
import { asPlannedTasks, validateTaskGraph } from '../support/dag.js';
import { toApprovalView } from '../support/approval-view.js';

/** Enough of the timeline for the home screen to show what is happening now. */
const HOME_EVENT_LIMIT = 30;
const HOME_MISSION_LIMIT = 20;

const ACTIVE_MISSION_STATUSES: readonly MissionStatus[] = [
  'PLANNING', 'EXECUTING', 'REVIEWING', 'QA', 'READY_TO_SHIP', 'RELEASED', 'OBSERVING',
];
const ATTENTION_MISSION_STATUSES: readonly MissionStatus[] = ['BLOCKED', 'AWAITING_PLAN_APPROVAL'];

export interface ProjectionDeps {
  readonly workspaces: WorkspaceRepositoryPort;
  readonly repositories: RepoRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly runs: RunRepositoryPort;
  readonly events: EventRepositoryPort;
  readonly artifacts: ArtifactRepositoryPort;
  readonly approvals: ApprovalRepositoryPort;
  readonly decisions: DecisionRepositoryPort;
  readonly evaluations: EvaluationRepositoryPort;
  readonly targets: ExecutionTargetRepositoryPort;
  readonly roles: RoleRepositoryPort;
  readonly runtimeProfiles: RuntimeProfileRepositoryPort;
  readonly runtimes: RuntimeService;
  readonly gates: GateService;
  readonly metrics: MetricsService;
}

/**
 * Read models (MVP.md §7.2).
 *
 * The renderer never joins. A mission screen is one request because this
 * assembles the join here, against indexes, rather than leaving the UI to make
 * six calls and correlate them - which is how a timeline ends up showing a task
 * next to a run from a previous attempt.
 *
 * Nothing here is cached. Every value is derived from the durable record on
 * demand, and the projection bus tells subscribers *when* to re-ask rather than
 * shipping them a diff. A cache would have to be invalidated correctly from
 * fifteen call sites, and a stale mission screen is worse than a re-read.
 */
export class ProjectionServiceImpl implements ProjectionService {
  constructor(private readonly deps: ProjectionDeps) {}

  async home(workspaceId?: string): Promise<HomeView> {
    const workspace = workspaceId === undefined
      ? this.deps.workspaces.list()[0] ?? null
      : this.deps.workspaces.get(asId<'WorkspaceId'>(workspaceId)) ?? null;

    const scope = workspace === null ? {} : { workspaceId: workspace.id };
    const missions = this.deps.missions.list({ ...scope, limit: HOME_MISSION_LIMIT });
    const summaries = missions.map((m) => this.#summary(m));

    return {
      workspace,
      activeMissions: summaries.filter((s) => ACTIVE_MISSION_STATUSES.includes(s.mission.status)),
      blockedMissions: summaries.filter((s) => ATTENTION_MISSION_STATUSES.includes(s.mission.status)),
      recentMissions: summaries,
      pendingApprovals: this.deps.approvals
        .list({ ...scope, statuses: ['PENDING'] })
        .map((a) => toApprovalView(this.deps, a)),
      runtimes: await this.#runtimeViews(workspace?.id),
      recentEvents: this.#recentEvents(missions),
    };
  }

  async missionDetail(id: MissionId): Promise<MissionDetail> {
    const mission = this.#requireMission(id);
    const workspace = this.deps.workspaces.get(mission.workspaceId);
    const tasks = this.deps.tasks.listByMission(id);

    return {
      mission,
      progress: this.deps.missions.progress(id),
      repository: mission.repositoryId === null
        ? null
        : this.deps.repositories.get(mission.repositoryId) ?? null,
      tasks: this.#taskViews(mission, tasks),
      artifacts: this.deps.artifacts.listByMission(id),
      approvals: this.deps.approvals.list({ missionId: id }),
      decisions: this.deps.decisions.listByMission(id),
      targets: this.deps.targets.listByMission(id),
      checks: tasks.flatMap((t) => this.deps.evaluations.listChecks(t.id)),
      evaluations: tasks.flatMap((t) => this.deps.evaluations.listEvaluations(t.id)),
      metrics: this.deps.metrics.compute(mission, workspace),
      plan: tasks.length === 0
        ? null
        : { summary: this.#planSummary(mission, tasks), tasks: asPlannedTasks(tasks) },
      planIssues: this.#planIssues(mission, tasks),
    };
  }

  async missionTasks(id: MissionId): Promise<readonly TaskView[]> {
    const mission = this.#requireMission(id);
    return this.#taskViews(mission, this.deps.tasks.listByMission(id));
  }

  missionEvents(
    id: MissionId,
    opts: { afterSequence?: number; limit?: number; semanticOnly?: boolean },
  ): readonly RunEventRecord[] {
    this.#requireMission(id);
    return this.deps.events.listByMission(id, opts);
  }

  targets(missionId?: string): readonly ExecutionTargetRecord[] {
    if (missionId !== undefined) {
      return this.deps.targets.listByMission(asId<'MissionId'>(missionId));
    }
    // Everything still holding disk or a process, across every mission - the
    // "machines" screen exists to answer "what is running right now?".
    return this.deps.targets.listByStatus(['PROVISIONING', 'READY', 'IN_USE']);
  }

  // ------------------------------------------------------------------ internals

  #taskViews(mission: Mission, tasks: readonly MissionTask[]): readonly TaskView[] {
    const levels = planLevels(asPlannedTasks(tasks));
    const targets = this.deps.targets.listByMission(mission.id);

    return tasks.map((task): TaskView => {
      const runs = [...this.deps.runs.listByTask(task.id)]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      const latestRun = runs[0] ?? null;
      const profile = latestRun === null
        ? undefined
        : this.deps.runtimeProfiles.get(asId<'RuntimeProfileId'>(latestRun.runtimeProfileId));
      const target = targets.find((t) => t.taskId === task.id);

      return {
        ...task,
        roleName: this.deps.roles.get(task.roleId, mission.workspaceId)?.name ?? task.roleId,
        level: levels.get(task.key) ?? 0,
        latestRun,
        runCount: runs.length,
        outputArtifacts: this.deps.artifacts.listByTask(task.id),
        checks: this.deps.evaluations.listChecks(task.id),
        // Evaluated live rather than stored: a gate is a view of the evidence as
        // it stands now, and a re-run check has to move the badge.
        // Only once the task has been judged: on a task that has not run, every
        // gate reads "Not met", and a plan full of red "Not met" badges looks
        // like a stuck mission when nothing has even started.
        gate: task.attempts > 0 && task.status !== 'RUNNING' ? this.deps.gates.evaluate(task) : null,
        pendingApprovalId: this.deps.approvals.pendingForTask(task.id)[0]?.id ?? null,
        runtimeName: profile?.name ?? latestRun?.runtimeProfileId ?? null,
        targetName: target?.name ?? null,
        repositoryName: task.repositoryId === null || task.repositoryId === mission.repositoryId
          ? null
          : this.deps.repositories.get(task.repositoryId)?.name ?? null,
      };
    });
  }

  #summary(mission: Mission): MissionSummary {
    const tasks = this.deps.tasks.listByMission(mission.id);
    const running = tasks.find((t) => t.status === 'RUNNING');
    const waiting = tasks.find((t) => t.status === 'AWAITING_APPROVAL');
    const blocked = tasks.find((t) => t.status === 'BLOCKED');
    const latest = this.deps.events.listByMission(mission.id, { limit: 1, semanticOnly: true });

    return {
      mission,
      progress: this.deps.missions.progress(mission.id),
      repositoryName: mission.repositoryId === null
        ? null
        : this.deps.repositories.get(mission.repositoryId)?.name ?? null,
      currentActivity: running?.title
        ?? (waiting === undefined ? null : `Waiting for approval: ${waiting.title}`)
        ?? (blocked === undefined ? null : `Blocked: ${blocked.title}`)
        ?? mission.statusReason,
      lastEventAt: latest[latest.length - 1]?.createdAt ?? null,
    };
  }

  async #runtimeViews(workspaceId: WorkspaceId | undefined): Promise<readonly RuntimeView[]> {
    try {
      return await this.deps.runtimes.list(workspaceId);
    } catch {
      // Health probes spawn processes. The home screen must render even when
      // one of them is broken - the runtimes panel is not worth a failed page.
      return [];
    }
  }

  #recentEvents(missions: readonly Mission[]): readonly RunEventRecord[] {
    const events = missions.flatMap((m) =>
      this.deps.events.listByMission(m.id, { limit: HOME_EVENT_LIMIT, semanticOnly: true }));
    return events
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-HOME_EVENT_LIMIT);
  }

  /** The planner's own words when they were stored, otherwise the shape. */
  #planSummary(mission: Mission, tasks: readonly MissionTask[]): string {
    const artifact = this.deps.artifacts.latest(mission.id, 'MissionPlan');
    return artifact?.summary ?? `${tasks.length} tasks.`;
  }

  /**
   * Re-validated on read, not remembered from planning time.
   *
   * A running mission's graph is mutated - remediation splices tasks in, the
   * integration service adds a conflict task - so the only honest answer to "is
   * this plan still coherent?" is to ask the validator about the graph that
   * exists now.
   */
  #planIssues(mission: Mission, tasks: readonly MissionTask[]): readonly PlanValidationIssue[] {
    if (tasks.length === 0) return [];
    const validated = validateTaskGraph(tasks, this.deps.roles.list(mission.workspaceId));
    return validated.ok ? [] : validated.error;
  }

  #requireMission(id: MissionId): Mission {
    const mission = this.deps.missions.get(id);
    if (mission === undefined) throw TandemiseError.notFound('Mission', id);
    return mission;
  }
}
