import type { Mission, MissionPriority, MissionRepositoryPort, UnitOfWork, WorkspaceRepositoryPort, Workspace } from '@tandemise/domain';
import {
  backlogOrder, choosePulls, describeWip, isInProgress, isTerminalMissionStatus, moveInBacklog, pulledDetail, pulledTitle,
} from '@tandemise/domain';
import type { BacklogItemView, BacklogView, MissionSummary, UpdateMissionRequest } from '@tandemise/api-contract';
import type { Clock, Logger, MissionId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, errorMessage } from '@tandemise/shared';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import type { PlanningService } from '../services.js';
import type { ReadinessService } from './readiness.js';

export interface BacklogDeps {
  readonly workspaces: WorkspaceRepositoryPort;
  readonly missions: MissionRepositoryPort;
  /** P6's gate, the one place readiness is decided. */
  readonly readiness: Pick<ReadinessService, 'evaluate'>;
  /** Enters PLANNING (through the same readiness check) and plans in the background. */
  readonly planning: Pick<PlanningService, 'begin'>;
  /** True while a refinement pass is running on the mission. */
  readonly refining: (missionId: MissionId) => boolean;
  /**
   * The monthly spend rule (P8): null when a mission of this priority may be
   * pulled, else the "Held: …" label. Optional so harnesses built before
   * limits still compose; the module always passes it.
   */
  readonly heldBySpend?: (workspaceId: WorkspaceId, priority: MissionPriority) => string | null;
  /** The list row a mission shows everywhere else, for the view. */
  readonly summaries: (workspaceId: WorkspaceId) => readonly MissionSummary[];
  readonly unitOfWork: UnitOfWork;
  /** Asks the scheduler for a pass, so a change to the queue is acted on now. */
  readonly wake: () => void;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
}

/**
 * The backlog and its pull (P7 spec §1).
 *
 * The daemon decides what is planned next from rows and counts only: the
 * backlog order (`compareBacklog`, a total order), the work-in-progress gate
 * over measured counts, and the readiness gate read through `ReadinessService`.
 * Nothing an agent says moves a mission out of the backlog.
 */
export class BacklogService {
  constructor(private readonly deps: BacklogDeps) {}

  view(workspaceId: WorkspaceId): BacklogView {
    const workspace = this.#requireWorkspace(workspaceId);
    const all = this.deps.missions.list({ workspaceId });
    const summaries = new Map(this.deps.summaries(workspaceId).map((s) => [s.mission.id, s]));
    const drafts = backlogOrder(all.filter((m) => m.status === 'DRAFT'));
    let queuePosition = 0;
    const items: BacklogItemView[] = drafts.map((mission) => {
      const readiness = this.deps.readiness.evaluate(mission.id);
      return {
        summary: summaries.get(mission.id) ?? bareSummary(mission),
        priority: mission.priority,
        queuePosition: mission.queuedAt === null ? null : ++queuePosition,
        ready: readiness.ready,
        readinessLabel: readiness.label,
        refining: this.deps.refining(mission.id),
        held: mission.queuedAt === null ? null : this.deps.heldBySpend?.(workspaceId, mission.priority) ?? null,
      };
    });
    const active = all.filter((m) => isInProgress(m.status)).length;
    const counts = { active, limit: workspace.maxActiveMissions, queued: queuePosition };
    return { workspaceId, ...counts, ...describeWip(counts), items };
  }

  /** Priority, rank, queue or a move; answers with the project's backlog. */
  update(missionId: MissionId, request: UpdateMissionRequest): BacklogView {
    const mission = this.#requireMission(missionId);
    const draftOnly = request.queued !== undefined || request.rank !== undefined || request.move !== undefined;
    if (draftOnly && mission.status !== 'DRAFT') {
      throw new TandemiseError('PRECONDITION_FAILED',
        `Only a draft can be queued or moved in the backlog; this mission is ${mission.status}.`,
        { details: { missionId, status: mission.status } });
    }
    if (request.priority !== undefined && isTerminalMissionStatus(mission.status)) {
      throw new TandemiseError('PRECONDITION_FAILED', `A ${mission.status} mission has no priority to change.`,
        { details: { missionId, status: mission.status } });
    }
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId };
    this.deps.recorder.deferred(() => this.deps.unitOfWork.transaction(() => {
      if (request.priority !== undefined || request.rank !== undefined || request.queued !== undefined) {
        this.deps.missions.update(missionId, {
          ...(request.priority === undefined ? {} : { priority: request.priority }),
          ...(request.rank === undefined ? {} : { rank: request.rank }),
          ...(request.queued === undefined
            ? {}
            // Queued again keeps its first time in the queue; the order never reads it.
            : { queuedAt: request.queued ? mission.queuedAt ?? this.deps.clock.now() : null }),
        });
      }
      if (request.move !== undefined) {
        const drafts = this.deps.missions.list({ workspaceId: mission.workspaceId, statuses: ['DRAFT'] });
        const moved = moveInBacklog(drafts, missionId, request.move);
        if (moved === null) {
          throw new TandemiseError('CONFLICT',
            request.move === 'up' ? 'This mission is already first in the backlog.' : 'This mission is already last in the backlog.',
            { details: { missionId, move: request.move } });
        }
        for (const update of moved.updates) {
          this.deps.missions.update(update.id as MissionId, { priority: update.priority, rank: update.rank });
        }
        if (moved.crossed !== null) {
          // Priority sorts first, so passing a mission of another priority takes its priority (ruling 1). Said, not silent.
          const where = request.move === 'up' ? 'above' : 'below';
          this.deps.recorder.note(scope,
            `Moved ${where} "${titleOf(drafts, moved.crossed.id)}" in the backlog, so it is now ${moved.moved.priority} priority.`);
        }
      }
      this.deps.recorder.invalidate('missions', missionId);
    }));
    this.deps.wake();
    return this.view(mission.workspaceId);
  }

  /**
   * One pull for every project: while the WIP gate passes, the first queued
   * draft that is ready is planned. Called by the scheduler at the top of each
   * pass. Resolves with the missions it pulled, in order.
   */
  async pull(): Promise<readonly MissionId[]> {
    const pulled: MissionId[] = [];
    for (const workspace of this.deps.workspaces.list()) {
      // Off: nothing to do, and no reason to read the missions at all.
      if (workspace.maxActiveMissions === null) continue;
      pulled.push(...await this.#pullFor(workspace));
    }
    return pulled;
  }

  async #pullFor(workspace: Workspace): Promise<readonly MissionId[]> {
    const all = this.deps.missions.list({ workspaceId: workspace.id });
    const active = all.filter((m) => isInProgress(m.status)).length;
    // The monthly spend rule (P8): over the warning level only urgent and high
    // missions are candidates; at the limit, none. A held mission stays queued
    // and is pulled once the month turns or the limit is raised.
    const queued = all.filter((m) => m.status === 'DRAFT' && m.queuedAt !== null)
      .filter((m) => (this.deps.heldBySpend?.(workspace.id, m.priority) ?? null) === null);
    if (queued.length === 0 || active >= (workspace.maxActiveMissions ?? 0)) return [];
    const candidates = queued.map((m) => ({
      id: m.id, priority: m.priority, rank: m.rank, createdAt: m.createdAt, queued: true,
      // A mission being refined is skipped: a pass landing on a planned mission would be refused.
      ready: !this.deps.refining(m.id) && this.deps.readiness.evaluate(m.id).ready,
    }));
    const plan = choosePulls({ active, limit: workspace.maxActiveMissions, candidates });
    const pulled: MissionId[] = [];
    for (const pull of plan.pulls) {
      const missionId = pull.id as MissionId;
      const scope: EventScope = { workspaceId: workspace.id, missionId };
      try {
        await this.deps.planning.begin(missionId);
        // After, not before: a pull the planner refused must not read as one that happened.
        this.deps.recorder.record(scope, { type: 'mission.pulled', position: pull.position, limit: pull.limit, active: pull.active, skipped: pull.skipped });
        this.deps.recorder.invalidate('missions', missionId);
        this.deps.log.info('backlog.pulled', { missionId, position: pull.position, limit: pull.limit, active: pull.active });
        pulled.push(missionId);
      } catch (e) {
        // Off the queue, or the same refusal would repeat on every tick. The
        // person sees why and can queue it again once it is fixed.
        this.deps.missions.update(missionId, { queuedAt: null });
        this.deps.recorder.note(scope, `Could not be pulled from the backlog: ${errorMessage(e)} It was taken off the queue.`, 'warn');
        this.deps.recorder.invalidate('missions', missionId);
        this.deps.log.warn('backlog.pull_failed', { missionId, error: errorMessage(e) });
        // The slot this pull would have used is still free; the next tick tries the next one.
        break;
      }
    }
    return pulled;
  }

  #requireWorkspace(id: WorkspaceId): Workspace {
    const workspace = this.deps.workspaces.get(id);
    if (workspace === undefined) throw TandemiseError.notFound('Workspace', id);
    return workspace;
  }

  #requireMission(id: MissionId): Mission {
    const mission = this.deps.missions.get(id);
    if (mission === undefined) throw TandemiseError.notFound('Mission', id);
    return mission;
  }
}

/** The words shared by the timeline row and the log. */
export function describePull(pull: { position: number; limit: number; active: number; skipped?: number }): string {
  return `${pulledTitle(pull)}. ${pulledDetail(pull)}`;
}

function titleOf(missions: readonly Mission[], id: string): string {
  return missions.find((m) => m.id === id)?.title ?? id;
}

function bareSummary(mission: Mission): MissionSummary {
  return {
    mission,
    progress: { totalTasks: 0, completed: 0, running: 0, blocked: 0, failed: 0, pendingApprovals: 0 },
    repositoryName: null,
    currentActivity: mission.statusReason,
    lastEventAt: null,
  };
}
