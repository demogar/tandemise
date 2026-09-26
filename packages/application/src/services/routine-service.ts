import type {
  MemberRepositoryPort, Mission, MissionRepositoryPort, Routine, RoutineRepositoryPort, RoutineRun, RoutineSchedule, RoutineTrigger,
  WorkspaceRepositoryPort,
} from '@tandemise/domain';
import {
  coalescedNote, createdNote, decideRoutineRun, dueSlots, evaluateReadiness, firstSlotAfter, isTerminalMissionStatus, missedNote,
  nextRunLabel, normalizeLimits, routineGoal, routineMissionTitle, scheduleLabel, scheduleProblem,
} from '@tandemise/domain';
import type {
  CreateMissionRequest, CreateRoutineRequest, RoutineRunView, RoutineView, UpdateRoutineRequest,
} from '@tandemise/api-contract';
import type { Clock, Logger, MemberId, RoutineId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId, errorMessage } from '@tandemise/shared';
import type { EventRecorder } from '../support/event-recorder.js';
import { requireSeat, type Caller } from '../support/identity.js';

export interface RoutineDeps {
  readonly routines: RoutineRepositoryPort;
  readonly workspaces: Pick<WorkspaceRepositoryPort, 'get'>;
  readonly missions: Pick<MissionRepositoryPort, 'list' | 'get'>;
  readonly members: MemberRepositoryPort;
  /**
   * The one way a routine adds work: `MissionService.create`, always with
   * `queued: true`. Nothing else in these deps can move a mission forward.
   */
  readonly createMission: (caller: Caller, request: CreateMissionRequest, origin: { routineId: RoutineId }) => Promise<Mission>;
  /** P10's report, written from facts; the "status report" kind. */
  readonly writeStatusReport: (workspaceId: WorkspaceId, caller: Caller) => Promise<{ artifactId: string; version: number }>;
  /** The project's monthly hard stop in words (P8), or null when under it. */
  readonly monthHardStop: (workspaceId: WorkspaceId) => string | null;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
}

const RECENT_RUNS = 5;

/**
 * Routines (P11 spec §1): standing work that adds itself to the backlog.
 *
 * A routine is a factory for queued drafts and nothing more. It decides only
 * whether a slot produces a mission (the pure `decideRoutineRun`), from the
 * injected clock and rows; whether that mission is ever worked on is decided
 * where it is for every mission - the readiness gate and the WIP limit in the
 * backlog pull, the spend limits at admission. Holding no reference to any of
 * those is what makes "a routine never gets past a gate" true by construction.
 */
export class RoutineService {
  /** Routines with a run in flight in this process: a second trigger waits its turn. */
  readonly #running = new Set<RoutineId>();

  constructor(private readonly deps: RoutineDeps) {}

  list(workspaceId: WorkspaceId): readonly RoutineView[] {
    if (this.deps.workspaces.get(workspaceId) === undefined) throw TandemiseError.notFound('Workspace', workspaceId);
    return this.deps.routines.list(workspaceId).map((r) => this.#view(r));
  }

  view(id: RoutineId): RoutineView {
    return this.#view(this.#require(id));
  }

  create(caller: Caller, workspaceId: WorkspaceId, request: CreateRoutineRequest): RoutineView {
    if (this.deps.workspaces.get(workspaceId) === undefined) throw TandemiseError.notFound('Workspace', workspaceId);
    const seat = requireSeat(this.deps, workspaceId, caller);
    const kind = request.kind ?? 'mission';
    const fields = this.#validated({
      name: request.name.trim(),
      kind,
      goal: (request.goal ?? '').trim(),
      successCriteria: lines(request.successCriteria ?? []),
      schedule: request.schedule,
    });
    const enabled = request.enabled ?? true;
    const routine = this.deps.routines.create({
      workspaceId,
      ...fields,
      priority: request.priority ?? 'normal',
      limits: request.limits === undefined || request.limits === null ? null : normalizeLimits(request.limits),
      workflowPreset: request.workflowPreset ?? null,
      enabled,
      nextRunAt: enabled ? this.#firstRun(fields.schedule) : null,
      createdBy: seat.id,
    });
    this.deps.log.info('routine.created', { routineId: routine.id, workspaceId, schedule: scheduleLabel(routine.schedule) });
    this.#changed();
    return this.#view(routine);
  }

  update(id: RoutineId, request: UpdateRoutineRequest): RoutineView {
    const current = this.#require(id);
    const fields = this.#validated({
      name: request.name?.trim() ?? current.name,
      kind: request.kind ?? current.kind,
      goal: request.goal?.trim() ?? current.goal,
      successCriteria: request.successCriteria === undefined ? current.successCriteria : lines(request.successCriteria),
      schedule: request.schedule ?? current.schedule,
    });
    const enabled = request.enabled ?? current.enabled;
    const rescheduled = request.schedule !== undefined && JSON.stringify(request.schedule) !== JSON.stringify(current.schedule);
    // Off clears the next run; back on, or a new schedule, starts from now. The
    // slots a routine was off for are not caught up: it was off on purpose.
    const nextRunAt = !enabled ? null : (!current.enabled || rescheduled || current.nextRunAt === null) ? this.#firstRun(fields.schedule) : current.nextRunAt;
    const updated = this.deps.routines.update(id, {
      ...fields,
      ...(request.priority === undefined ? {} : { priority: request.priority }),
      ...(request.limits === undefined ? {} : { limits: request.limits === null ? null : normalizeLimits(request.limits) }),
      ...(request.workflowPreset === undefined ? {} : { workflowPreset: request.workflowPreset }),
      enabled,
      nextRunAt,
    });
    this.#changed();
    return this.#view(updated);
  }

  remove(id: RoutineId): void {
    this.#require(id);
    // Its missions stay: they are ordinary missions now, and the column pointing here is cleared.
    this.deps.routines.remove(id);
    this.#changed();
  }

  /** Runs once now, through the same checks as a scheduled run; the schedule is unchanged. */
  async runNow(caller: Caller, id: RoutineId): Promise<RoutineView> {
    const routine = this.#require(id);
    requireSeat(this.deps, routine.workspaceId, caller);
    if (this.#running.has(id)) {
      throw new TandemiseError('CONFLICT', 'This routine is running right now; try again in a moment.', { details: { routineId: id } });
    }
    await this.#run(routine, 'manual', this.deps.clock.epochMs(), 1, null);
    return this.view(id);
  }

  /**
   * One pass over every due routine. Called by the scheduler before the
   * backlog pull, so a mission added here can be pulled in the same pass.
   * Resolves with the runs it recorded.
   */
  async tick(): Promise<readonly RoutineRun[]> {
    const nowMs = this.deps.clock.epochMs();
    const recorded: RoutineRun[] = [];
    for (const routine of this.deps.routines.listDue(this.deps.clock.now())) {
      if (routine.nextRunAt === null || this.#running.has(routine.id)) continue;
      let due;
      try {
        due = dueSlots(routine.schedule, Date.parse(routine.nextRunAt), nowMs);
      } catch (e) {
        this.deps.log.warn('routine.bad_schedule', { routineId: routine.id, error: errorMessage(e) });
        continue;
      }
      if (due.count === 0 || due.lastMs === null || due.firstMs === null) continue;
      // Claimed before anything else, in one conditional write: a second pass
      // (or a slow run) finds the next run already moved and fires nothing.
      if (!this.deps.routines.claim(routine.id, routine.nextRunAt, iso(due.nextMs))) continue;
      const missed = due.count > 1 ? { count: due.count - 1, firstMs: due.firstMs, lastMs: due.lastMissedMs ?? due.firstMs } : null;
      recorded.push(...await this.#run(routine, 'schedule', due.lastMs, due.count, missed));
    }
    return recorded;
  }

  // ------------------------------------------------------------------ one run

  async #run(
    routine: Routine,
    trigger: RoutineTrigger,
    slotMs: number,
    due: number,
    missed: { count: number; firstMs: number; lastMs: number } | null,
  ): Promise<readonly RoutineRun[]> {
    this.#running.add(routine.id);
    const runs: RoutineRun[] = [];
    try {
      const ranAt = this.deps.clock.now();
      if (missed !== null) {
        runs.push(this.#record(routine, {
          trigger, scheduledFor: iso(missed.firstMs), ranAt, outcome: 'missed',
          detail: missedNote(missed.count, missed.firstMs, missed.lastMs), skippedCount: missed.count, missionId: null, artifactId: null,
        }));
      }
      const active = routine.kind === 'mission' ? this.#activeMission(routine) : undefined;
      const decision = decideRoutineRun({
        kind: routine.kind,
        due,
        previousActive: active !== undefined,
        limitReason: routine.kind === 'mission' ? this.deps.monthHardStop(routine.workspaceId) : null,
      });
      const scheduledFor = trigger === 'schedule' ? iso(slotMs) : null;
      if (decision.action === 'none') return runs;
      if (decision.action === 'skip') {
        if (active !== undefined && decision.outcome === 'skipped_active') {
          this.deps.recorder.note({ workspaceId: routine.workspaceId, missionId: active.id }, coalescedNote(routine.name, slotMs, trigger));
          this.deps.recorder.invalidate('missions', active.id);
        }
        runs.push(this.#record(routine, {
          trigger, scheduledFor, ranAt, outcome: decision.outcome, detail: decision.detail, skippedCount: 0,
          missionId: active?.id ?? null, artifactId: null,
        }));
        this.deps.log.info('routine.skipped', { routineId: routine.id, outcome: decision.outcome });
        return runs;
      }
      try {
        const caller = this.#callerFor(routine);
        if (routine.kind === 'status_report') {
          const report = await this.deps.writeStatusReport(routine.workspaceId, caller);
          runs.push(this.#record(routine, {
            trigger, scheduledFor, ranAt, outcome: 'reported', detail: `Wrote status report v${report.version}`, skippedCount: 0,
            missionId: null, artifactId: report.artifactId,
          }));
        } else {
          const title = routineMissionTitle(routine.name, slotMs);
          const mission = await this.deps.createMission(caller, {
            workspaceId: routine.workspaceId,
            title,
            goal: routineGoal(routine.goal, slotMs),
            successCriteria: [...routine.successCriteria],
            priority: routine.priority,
            // Into the backlog, never planned from here: the pull decides (ruling 1).
            queued: true,
            ...(routine.limits === null ? {} : { limits: [...routine.limits] }),
            ...(routine.workflowPreset === null ? {} : { workflowPreset: routine.workflowPreset }),
          }, { routineId: routine.id });
          this.deps.recorder.note({ workspaceId: routine.workspaceId, missionId: mission.id }, createdNote(routine.name, slotMs, trigger));
          runs.push(this.#record(routine, {
            trigger, scheduledFor, ranAt, outcome: 'created', detail: `Created “${mission.title}”`, skippedCount: 0,
            missionId: mission.id, artifactId: null,
          }));
          this.deps.log.info('routine.created_mission', { routineId: routine.id, missionId: mission.id, trigger });
        }
      } catch (e) {
        runs.push(this.#record(routine, {
          trigger, scheduledFor, ranAt, outcome: 'failed', detail: `Could not run: ${errorMessage(e)}`, skippedCount: 0,
          missionId: null, artifactId: null,
        }));
        this.deps.log.warn('routine.failed', { routineId: routine.id, error: errorMessage(e) });
      }
      return runs;
    } finally {
      this.#running.delete(routine.id);
      this.#changed();
    }
  }

  /** Writes the run note and the routine's last outcome together. */
  #record(routine: Routine, run: Omit<RoutineRun, 'id' | 'routineId'>): RoutineRun {
    const recorded = this.deps.routines.recordRun({ ...run, routineId: routine.id });
    this.deps.routines.update(routine.id, {
      lastRunAt: run.ranAt,
      lastOutcome: run.outcome,
      lastDetail: run.detail,
      ...(run.outcome === 'created' && run.missionId !== null ? { lastMissionId: run.missionId } : {}),
      ...(run.artifactId === null ? {} : { lastArtifactId: run.artifactId }),
    });
    return recorded;
  }

  /** An unfinished mission from this routine; a queued draft counts (ruling 2). */
  #activeMission(routine: Routine): Mission | undefined {
    return this.deps.missions.list({ workspaceId: routine.workspaceId })
      .filter((m) => m.routineId === routine.id && !isTerminalMissionStatus(m.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  }

  /** The person who set the routine up; a routine never acts under someone else's name (ruling 12). */
  #callerFor(routine: Routine): Caller {
    const member = routine.createdBy === null ? undefined : this.deps.members.get(asId<'MemberId'>(routine.createdBy) as MemberId);
    if (member === undefined || member.personId === null || member.status !== 'active') {
      throw new TandemiseError('PRECONDITION_FAILED', 'The person who set up this routine is no longer on the team. Edit the routine to take it over.');
    }
    return { personId: member.personId };
  }

  // ------------------------------------------------------------------ views

  #view(routine: Routine): RoutineView {
    const nowMs = this.deps.clock.epochMs();
    const active = routine.kind === 'mission' ? this.#activeMission(routine) : undefined;
    const recent: RoutineRunView[] = this.deps.routines.recentRuns(routine.id, RECENT_RUNS).map((r) => ({
      id: r.id, trigger: r.trigger, ranAt: r.ranAt, outcome: r.outcome, label: r.detail, missionId: r.missionId, artifactId: r.artifactId,
    }));
    return {
      routine,
      scheduleLabel: scheduleLabel(routine.schedule),
      nextRunLabel: nextRunLabel(routine.nextRunAt === null ? null : Date.parse(routine.nextRunAt), nowMs),
      lastLabel: routine.lastDetail,
      activeMissionId: active?.id ?? null,
      recent,
    };
  }

  // ------------------------------------------------------------------ helpers

  #validated(fields: { name: string; kind: Routine['kind']; goal: string; successCriteria: readonly string[]; schedule: RoutineSchedule }) {
    if (fields.name.length === 0) throw TandemiseError.validation('A routine needs a name.');
    const problem = scheduleProblem(fields.schedule);
    if (problem !== null) throw TandemiseError.validation(problem, { schedule: fields.schedule });
    if (fields.kind === 'mission') {
      if (fields.goal.length < 3) throw TandemiseError.validation('Say what each mission should do (its goal).');
      // Ready by construction: the readiness gate a created mission will meet,
      // applied to the routine itself, so no routine can make a draft that waits forever.
      const readiness = evaluateReadiness({ criteria: fields.successCriteria.length, openQuestions: 0, proposedPending: 0 });
      if (!readiness.ready) {
        throw TandemiseError.validation('A routine needs at least one Done-when line, so every mission it adds is ready to plan.');
      }
    }
    return fields;
  }

  #firstRun(schedule: RoutineSchedule): string {
    return iso(firstSlotAfter(schedule, this.deps.clock.epochMs()));
  }

  #require(id: RoutineId): Routine {
    const routine = this.deps.routines.get(id);
    if (routine === undefined) throw TandemiseError.notFound('Routine', id);
    return routine;
  }

  /** The Routines tab lives under Missions, so the missions topic refreshes it. */
  #changed(): void {
    this.deps.recorder.invalidate('missions');
  }
}

function lines(list: readonly string[]): string[] {
  return list.map((l) => l.trim()).filter((l) => l.length > 0);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

