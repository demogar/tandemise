import type {
  Approval, ApprovalRepositoryPort, EventRepositoryPort, GateFacts, Limit, LimitIncident, LimitRepositoryPort, LimitStatus, Mission,
  MissionRepositoryPort, MissionStatus, RunRepositoryPort, TaskRepositoryPort, UnitOfWork, UsageTotals, Workspace,
  WorkspaceRepositoryPort,
} from '@tandemise/domain';
import {
  KEEP_PAUSED_OPTION, RAISE_LIMIT_OPTION, UNMEASURED_USD_NOTE, admits, barLabel, canTransition, evaluateLimits, formatAmount,
  heldLabel, isLimitPause, isTerminalMissionStatus, limitFacts, metricLabel, monthWindow, monthWindowOf, ofAmount, pullAllowedAtSpend,
  reachedReason, suggestedRaise, warningNote, withAmount, worstLevel, type LimitLevel, type UsageWindow,
} from '@tandemise/domain';
import type {
  LimitAlertView, LimitStatusView, MissionLimitsView, UsageView, WorkspaceUsageView,
} from '@tandemise/api-contract';
import type { ApprovalFactory } from '@tandemise/policy';
import type { Clock, Logger, MissionId, RunId, TaskId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError } from '@tandemise/shared';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import type { RequestAddress } from '../engine/reviews.js';
import type { LimitGuard } from '../engine/task-executor.js';

/** Statuses a limit stop pauses: the ones the scheduler dispatches in. */
const WORKING: readonly MissionStatus[] = ['EXECUTING', 'REVIEWING', 'QA', 'READY_TO_SHIP'];
/** The reason a task stopped by a limit carries while it waits to run again. */
const STOPPED_TASK_REASON = 'Stopped at a limit; it runs again when the mission resumes.';

export interface LimitDeps {
  readonly workspaces: WorkspaceRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly runs: RunRepositoryPort;
  readonly approvals: ApprovalRepositoryPort;
  readonly limits: LimitRepositoryPort;
  readonly events: EventRepositoryPort;
  readonly approvalFactory: ApprovalFactory;
  /** Who a card with no task is for: the project's owners. */
  readonly address: (workspaceId: WorkspaceId) => RequestAddress;
  /** Stops a task's run in this process. */
  readonly cancelTask: (taskId: TaskId) => void;
  /** Asks the scheduler for a pass, so a resumed mission starts at once. */
  readonly wake: () => void;
  readonly unitOfWork: UnitOfWork;
  readonly recorder: EventRecorder;
  /** The injected clock: month windows are read from it, never from the system clock. */
  readonly clock: Clock;
  readonly log: Logger;
}

interface Scope {
  readonly kind: 'mission' | 'month';
  readonly workspace: Workspace;
  /** The mission for a mission scope; for a month, the mission whose run was measured, if any. */
  readonly mission: Mission | null;
  readonly windowStart: string;
  readonly windowEnd: string | null;
  readonly statuses: readonly LimitStatus[];
  readonly totals: UsageTotals;
}

/**
 * Hard limits on spend and time (P8 spec §1-§3).
 *
 * The daemon's rule, enforced at two points: admission (nothing is dispatched
 * in a mission or project at 100% of a limit) and after every run's usage is
 * recorded (warn at the warning level, stop at 100%). A stop pauses the work,
 * stops runs in flight, and opens one card per limit crossed: raise the limit
 * to a number and resume, or keep it paused. Every number is measured from
 * `usage_records`; a metric no runtime reports is "not reported", never 0.
 */
export class LimitService implements LimitGuard {
  constructor(private readonly deps: LimitDeps) {}

  // ------------------------------------------------------------ measuring

  /** The mission's effective limits: its own, else the project's defaults. */
  effectiveLimits(mission: Mission, workspace: Workspace): { limits: readonly Limit[]; source: MissionLimitsView['source'] } {
    if (mission.limits !== null && mission.limits !== undefined) return { limits: mission.limits, source: mission.limits.length === 0 ? 'none' : 'mission' };
    return workspace.defaultMissionLimits.length > 0
      ? { limits: workspace.defaultMissionLimits, source: 'project' }
      : { limits: [], source: 'none' };
  }

  #missionScope(mission: Mission, workspace: Workspace): Scope {
    const totals = this.deps.limits.usageForMission(mission.id);
    const { limits } = this.effectiveLimits(mission, workspace);
    return {
      kind: 'mission', workspace, mission, windowStart: mission.createdAt, windowEnd: null,
      statuses: evaluateLimits(limits, totals), totals,
    };
  }

  #monthScope(workspace: Workspace, mission: Mission | null, window: UsageWindow = this.#window()): Scope {
    const totals = this.deps.limits.usageForWorkspace(workspace.id, window.start, window.end);
    return {
      kind: 'month', workspace, mission, windowStart: window.start, windowEnd: window.end,
      statuses: evaluateLimits(workspace.monthlyLimits, totals), totals,
    };
  }

  #window(): UsageWindow {
    return monthWindow(this.deps.clock.epochMs());
  }

  /** The project's monthly level now: what the backlog's spend rule reads. */
  monthLevel(workspaceId: WorkspaceId): { level: LimitLevel; status: LimitStatus | null } {
    const workspace = this.deps.workspaces.get(workspaceId);
    if (workspace === undefined || workspace.monthlyLimits.length === 0) return { level: 'ok', status: null };
    const scope = this.#monthScope(workspace, null);
    const level = worstLevel(scope.statuses);
    const status = [...scope.statuses].filter((s) => s.level === level).sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0] ?? null;
    return { level, status };
  }

  /**
   * The backlog rule (P7 + P8): may a mission of this priority be pulled now?
   * Null when it may; otherwise the row's "Held: …" label.
   */
  heldFor(workspaceId: WorkspaceId, priority: Mission['priority']): string | null {
    const { level, status } = this.monthLevel(workspaceId);
    if (status === null || pullAllowedAtSpend(priority, level)) return null;
    return heldLabel(status);
  }

  /** Facts for a gate that reads limits. */
  facts(missionId: MissionId): GateFacts {
    const mission = this.deps.missions.get(missionId);
    const workspace = mission === undefined ? undefined : this.deps.workspaces.get(mission.workspaceId);
    if (mission === undefined || workspace === undefined) return {};
    const m = this.#missionScope(mission, workspace);
    return { ...limitFacts({ mission: { totals: m.totals, statuses: m.statuses }, month: this.#monthScope(workspace, mission).statuses }) };
  }

  // ------------------------------------------------------------ admission

  /**
   * Null when work may start in the mission; otherwise why not. A scope found
   * at its limit is stopped here too, so a limit lowered below what was used,
   * or a project that crossed its month on another mission's run, stops this
   * mission before it spends more.
   */
  admit(missionId: MissionId): string | null {
    const mission = this.deps.missions.get(missionId);
    const workspace = mission === undefined ? undefined : this.deps.workspaces.get(mission.workspaceId);
    if (mission === undefined || workspace === undefined) return null;
    for (const scope of [this.#missionScope(mission, workspace), this.#monthScope(workspace, mission)]) {
      if (admits(scope.statuses)) continue;
      const over = scope.statuses.find((s) => s.level === 'hard')!;
      this.#stop(scope, over);
      return reachedReason(over, scope.kind);
    }
    return null;
  }

  /** The same question without stopping anything: for Resume, which must not start work over a limit. */
  refusal(missionId: MissionId): string | null {
    const mission = this.deps.missions.get(missionId);
    const workspace = mission === undefined ? undefined : this.deps.workspaces.get(mission.workspaceId);
    if (mission === undefined || workspace === undefined) return null;
    for (const scope of [this.#missionScope(mission, workspace), this.#monthScope(workspace, mission)]) {
      const over = scope.statuses.find((s) => s.level === 'hard');
      if (over !== undefined) return reachedReason(over, scope.kind);
    }
    return null;
  }

  // -------------------------------------------------------- after a run

  afterUsage(missionId: MissionId, finishedRunId: RunId): void {
    const finishedTask = this.deps.runs.get(finishedRunId)?.taskId ?? null;
    const mission = this.deps.missions.get(missionId);
    const workspace = mission === undefined ? undefined : this.deps.workspaces.get(mission.workspaceId);
    if (mission === undefined || workspace === undefined) return;
    for (const scope of [this.#missionScope(mission, workspace), this.#monthScope(workspace, mission)]) {
      for (const status of scope.statuses) {
        if (status.level === 'hard') this.#stop(scope, status, finishedTask);
        else if (status.level === 'soft') this.#warn(scope, status);
        else if (status.level === 'unmeasured' && scope.kind === 'mission' && scope.totals.runs > 0) this.#unmeasured(mission);
      }
    }
  }

  /** Once per limit crossed: a soft incident and a timeline note. */
  #warn(scope: Scope, status: LimitStatus): void {
    const key = this.#key(scope, status, 'soft');
    if (this.deps.limits.find(key) !== undefined) return;
    try {
      this.deps.limits.create({ ...key, windowEnd: scope.windowEnd, amountObserved: status.observed ?? 0, status: 'open', approvalId: null, pausedMissionIds: [] });
    } catch (e) {
      // Another pass wrote it first: the unique index is the rule, and the note is already said.
      if (e instanceof TandemiseError && e.code === 'CONFLICT') return;
      throw e;
    }
    if (scope.mission !== null) {
      this.deps.recorder.note(this.#scopeOf(scope.mission), warningNote(status, scope.kind), 'warn');
      this.deps.recorder.invalidate('missions', scope.mission.id);
    }
    this.deps.recorder.invalidate('workspaces');
  }

  /** A USD limit on a runtime that reports no cost can never stop anything: said once, not silently ignored. */
  #unmeasured(mission: Mission): void {
    const said = this.deps.events.listByMission(mission.id, { semanticOnly: true })
      .some((r) => r.body.type === 'note' && r.body.text === UNMEASURED_USD_NOTE);
    if (said) return;
    this.deps.recorder.note(this.#scopeOf(mission), UNMEASURED_USD_NOTE, 'warn');
    this.deps.recorder.invalidate('missions', mission.id);
  }

  /**
   * The hard stop. Idempotent: an open incident for this limit already stopped
   * the work, and only makes sure the scope is still paused; a closed one (kept
   * paused, then resumed some other way) is reopened with a new card.
   */
  #stop(scope: Scope, status: LimitStatus, exceptTaskId: TaskId | null = null): void {
    const key = this.#key(scope, status, 'hard');
    const existing = this.deps.limits.find(key);
    const targets = this.#targets(scope);
    const reason = reachedReason(status, scope.kind);

    if (existing?.status === 'open') {
      const late = targets.filter((m) => !existing.pausedMissionIds.includes(m.id));
      if (late.length === 0 && targets.every((m) => m.status === 'PAUSED')) return;
      this.#applyPause(targets, reason, exceptTaskId);
      if (late.length > 0) {
        this.deps.limits.transition(existing.id, 'open', 'open', { pausedMissionIds: [...existing.pausedMissionIds, ...late.map((m) => m.id)] });
      }
      return;
    }

    const paused = this.deps.recorder.deferred(() => this.deps.unitOfWork.transaction(() => {
      const approval = this.#card(scope, status);
      this.deps.approvals.create(approval);
      const pausedIds = targets.map((m) => m.id);
      if (existing === undefined) {
        this.deps.limits.create({ ...key, windowEnd: scope.windowEnd, amountObserved: status.observed ?? 0, status: 'open', approvalId: approval.id, pausedMissionIds: pausedIds });
      } else {
        this.deps.limits.transition(existing.id, existing.status, 'open', { approvalId: approval.id, amountObserved: status.observed ?? 0, pausedMissionIds: pausedIds });
      }
      if (scope.mission !== null) {
        this.deps.recorder.record(this.#scopeOf(scope.mission), { type: 'approval.requested', approvalId: approval.id });
      }
      this.#applyPause(targets, reason, exceptTaskId);
      this.deps.recorder.invalidate('approvals', scope.mission?.id);
      return targets;
    }));
    this.deps.log.info('limits.stopped', { scope: scope.kind, workspaceId: scope.workspace.id, missionId: scope.mission?.id, metric: status.metric, observed: status.observed, amount: status.amount, paused: paused.length });
  }

  /** What a stop pauses: the mission itself, or every working mission in the project. */
  #targets(scope: Scope): Mission[] {
    if (scope.kind === 'mission') return scope.mission === null ? [] : [this.deps.missions.get(scope.mission.id) ?? scope.mission];
    return this.deps.missions.list({ workspaceId: scope.workspace.id }).filter((m) => WORKING.includes(m.status) || m.status === 'PAUSED');
  }

  /** Pauses each mission that can be, and stops its runs in flight (roadmap decision 6). */
  #applyPause(missions: readonly Mission[], reason: string, exceptTaskId: TaskId | null): void {
    for (const mission of missions) {
      const current = this.deps.missions.get(mission.id) ?? mission;
      if (current.status !== 'PAUSED' && canTransition(current.status, 'PAUSED') && !isTerminalMissionStatus(current.status)) {
        this.#setStatus(current, 'PAUSED', reason);
      } else if (current.status === 'PAUSED' && current.statusReason !== reason) {
        this.deps.missions.update(current.id, { statusReason: reason });
        this.deps.recorder.invalidate('missions', current.id);
      }
      this.#stopRuns(current, exceptTaskId);
    }
  }

  /**
   * Work still going in the mission is stopped: every RUNNING task but the one
   * whose finished run was just measured (its work is done and is judged as
   * usual). A task is stopped even before its run row exists - an attempt
   * choosing a runtime has not written one yet. Tasks go back to READY first,
   * so the stopped attempt settles as "ready to run again", not as a
   * cancelled task that would block everything after it.
   */
  #stopRuns(mission: Mission, exceptTaskId: TaskId | null): void {
    const live = this.deps.tasks.listByMission(mission.id).filter((t) => t.status === 'RUNNING' && t.id !== exceptTaskId);
    for (const task of live) {
      this.deps.tasks.update(task.id, { status: 'READY', statusReason: STOPPED_TASK_REASON });
      this.deps.recorder.record({ ...this.#scopeOf(mission), taskId: task.id, roleId: task.roleId }, {
        type: 'task.status', from: task.status, to: 'READY', reason: STOPPED_TASK_REASON,
      });
      this.deps.cancelTask(task.id);
    }
    if (live.length > 0) this.deps.recorder.invalidate('tasks', mission.id);
  }

  #card(scope: Scope, status: LimitStatus): Approval {
    const amounts = ofAmount(status.metric, status.observed ?? 0, status.amount);
    const suggested = suggestedRaise(status);
    const who = scope.kind === 'mission' ? `“${scope.mission?.title ?? 'This mission'}”` : 'This project';
    const unit = formatAmount(status.metric, status.amount);
    return this.deps.approvalFactory.createOrThrow({
      workspaceId: scope.workspace.id,
      missionId: scope.kind === 'mission' ? scope.mission?.id ?? null : null,
      kind: 'intervention',
      risk: 'read',
      title: scope.kind === 'mission'
        ? `${who} reached its limit: ${amounts}`
        : `This project reached its monthly limit: ${amounts} this month`,
      rationale: scope.kind === 'mission'
        ? `${who} used ${amounts}, the limit you set. Work stopped: running work was stopped and nothing more starts until you decide.`
        : `The project used ${amounts} this month, the monthly limit you set. Work stopped in every mission that was running, and nothing more starts until you decide.`,
      effect: `Raise the limit above ${formatAmount(status.metric, status.observed ?? 0)} and ${scope.kind === 'mission' ? 'the mission resumes' : 'the paused missions resume'} where ${scope.kind === 'mission' ? 'it' : 'they'} stopped. Keep paused and nothing more runs; you can raise the limit later.`,
      evidence: [
        { kind: 'text', label: metricLabel(status.metric), value: `${amounts} used (${Math.floor(status.percent ?? 0)}%)` },
        { kind: 'text', label: 'Limit', value: `${unit}${scope.kind === 'month' ? ' per month' : ''}, warning at ${status.warnPercent}%` },
        { kind: 'text', label: 'Suggested', value: formatAmount(status.metric, suggested) },
      ],
      options: [
        { id: RAISE_LIMIT_OPTION, label: 'Raise limit and resume', recommended: true },
        { id: KEEP_PAUSED_OPTION, label: 'Keep paused' },
      ],
      recommendedOptionId: RAISE_LIMIT_OPTION,
      ...this.deps.address(scope.workspace.id),
    });
  }

  #key(scope: Scope, status: LimitStatus, threshold: 'soft' | 'hard') {
    return {
      workspaceId: scope.workspace.id,
      missionId: scope.kind === 'mission' ? scope.mission?.id ?? null : null,
      metric: status.metric,
      windowStart: scope.windowStart,
      threshold,
      amountLimit: status.amount,
    } as const;
  }

  // ------------------------------------------------------------- deciding

  /** The incident a card belongs to, or undefined when it is not a limit card. */
  incidentFor(approval: Approval): LimitIncident | undefined {
    if (approval.kind !== 'intervention' || approval.taskId !== null) return undefined;
    return this.deps.limits.byApproval(approval.id);
  }

  /**
   * Refuses a raise that would stop the work again at once. Called before the
   * decision is written, so a refused raise leaves the card open.
   */
  validateDecision(approval: Approval, optionId: string, raiseTo: number | undefined): void {
    const incident = this.incidentFor(approval);
    if (incident === undefined || optionId !== RAISE_LIMIT_OPTION) return;
    const unit = formatAmount(incident.metric, incident.amountLimit);
    if (raiseTo === undefined) {
      throw TandemiseError.validation(`Say what to raise the limit to: a number above the ${unit} it is now.`, { optionId });
    }
    const observed = this.#observedNow(incident);
    if (raiseTo <= incident.amountLimit || (observed !== null && raiseTo <= observed)) {
      const floor = Math.max(incident.amountLimit, observed ?? 0);
      throw TandemiseError.validation(
        `Raise it above ${formatAmount(incident.metric, floor)}: at ${formatAmount(incident.metric, raiseTo)} the work would stop again at once.`,
        { optionId, raiseTo, observed, limit: incident.amountLimit },
      );
    }
  }

  /**
   * The decision on a limit card, inside the approval's transaction. The
   * incident moves open → resolved exactly once: a second decision (a double
   * click, two windows) finds it resolved and changes nothing, so it can
   * never resume twice.
   */
  decide(approval: Approval, optionId: string, raiseTo: number | undefined, actorId: string): void {
    const incident = this.incidentFor(approval);
    if (incident === undefined) return;
    const resolved = this.deps.limits.transition(incident.id, 'open', 'resolved');
    if (resolved === null) return;
    const workspace = this.deps.workspaces.get(incident.workspaceId);
    if (workspace === undefined) return;
    const paused = resolved.pausedMissionIds
      .map((id) => this.deps.missions.get(id))
      .filter((m): m is Mission => m !== undefined && m.status === 'PAUSED');

    if (optionId === RAISE_LIMIT_OPTION && raiseTo !== undefined) {
      const from = formatAmount(incident.metric, incident.amountLimit);
      const to = formatAmount(incident.metric, raiseTo);
      if (incident.missionId !== null) {
        const mission = this.deps.missions.get(incident.missionId);
        if (mission === undefined) return;
        this.deps.missions.update(mission.id, { limits: withAmount(this.effectiveLimits(mission, workspace).limits, incident.metric, raiseTo) });
        this.deps.recorder.note({ ...this.#scopeOf(mission), actorId }, `Limit raised from ${from} to ${to}.`);
      } else {
        this.deps.workspaces.update(workspace.id, { monthlyLimits: withAmount(workspace.monthlyLimits, incident.metric, raiseTo) });
        for (const mission of paused) this.deps.recorder.note({ ...this.#scopeOf(mission), actorId }, `The project's monthly limit was raised from ${from} to ${to}.`);
        this.deps.recorder.invalidate('workspaces');
      }
      this.#closeSoft(incident);
      for (const mission of paused) {
        // Another limit may still hold it: resume only what nothing else stops.
        if (this.refusal(mission.id) !== null) continue;
        this.#setStatus(mission, 'EXECUTING', `Limit raised to ${to}; resumed.`, actorId);
      }
      this.deps.wake();
      return;
    }

    // Keep paused: the card is answered, the work stays where it stopped, and the reason says how to go on.
    for (const mission of paused) {
      const reason = `Kept paused at its limit: ${ofAmount(incident.metric, incident.amountObserved, incident.amountLimit)}. Raise the limit to resume.`;
      this.deps.missions.update(mission.id, { statusReason: reason });
      this.deps.recorder.note({ ...this.#scopeOf(mission), actorId }, reason);
      this.deps.recorder.invalidate('missions', mission.id);
    }
  }

  /** Soft incidents of a limit that was raised are over: the new limit warns afresh. */
  #closeSoft(incident: LimitIncident): void {
    const soft = this.deps.limits.find({ ...incident, threshold: 'soft', amountLimit: incident.amountLimit });
    if (soft?.status === 'open') this.deps.limits.transition(soft.id, 'open', 'resolved');
  }

  #observedNow(incident: LimitIncident): number | null {
    const totals = incident.missionId === null
      ? this.deps.limits.usageForWorkspace(incident.workspaceId, incident.windowStart, incident.windowEnd ?? this.#window().end)
      : this.deps.limits.usageForMission(incident.missionId);
    const status = evaluateLimits([{ metric: incident.metric, amount: incident.amountLimit, warnPercent: 80 }], totals)[0]!;
    return status.observed;
  }

  // --------------------------------------------------------- changing limits

  /** PATCH mission `{limits}`: its own list, or null for the project's defaults. */
  setMissionLimits(missionId: MissionId, limits: readonly Limit[] | null, actorId: string | null = null): void {
    const mission = this.deps.missions.get(missionId);
    if (mission === undefined) throw TandemiseError.notFound('Mission', missionId);
    if (isTerminalMissionStatus(mission.status)) {
      throw new TandemiseError('PRECONDITION_FAILED', `A ${mission.status} mission has no limits to change.`, { details: { missionId } });
    }
    this.deps.recorder.deferred(() => this.deps.unitOfWork.transaction(() => {
      this.deps.missions.update(missionId, { limits });
      const workspace = this.deps.workspaces.get(mission.workspaceId);
      const effective = workspace === undefined ? [] : this.effectiveLimits({ ...mission, limits }, workspace).limits;
      this.deps.recorder.note({ ...this.#scopeOf(mission), actorId },
        effective.length === 0 ? 'Limits removed: nothing stops this mission for time or spend.' : `Limits set: ${effective.map((l) => formatAmount(l.metric, l.amount)).join(', ')}.`);
      this.deps.recorder.invalidate('missions', missionId);
    }));
    this.limitsChanged(mission.workspaceId, actorId);
  }

  /** A limit lowered below what was used stops the work now, not after the next run. */
  #stopIfOver(workspaceId: WorkspaceId): void {
    for (const mission of this.deps.missions.list({ workspaceId, statuses: WORKING })) this.admit(mission.id);
  }

  /**
   * After any limit changed: an open stop whose limit no longer stops anything
   * is dismissed with its card, and the missions it paused resume. Changing the
   * limit is the same decision as raising it on the card. A mission kept paused
   * at a limit resumes too once no limit holds it: "Raise the limit to resume"
   * is what its reason told the person to do.
   */
  limitsChanged(workspaceId: WorkspaceId, actorId: string | null = null): void {
    const workspace = this.deps.workspaces.get(workspaceId);
    if (workspace === undefined) return;
    let resumed = false;
    this.deps.recorder.deferred(() => this.deps.unitOfWork.transaction(() => {
      for (const incident of this.deps.limits.listOpen(workspaceId)) {
        if (incident.threshold !== 'hard') continue;
        const mission = incident.missionId === null ? null : this.deps.missions.get(incident.missionId) ?? null;
        const scope = mission === null ? this.#monthScope(workspace, null, this.#windowAt(incident)) : this.#missionScope(mission, workspace);
        const now = scope.statuses.find((s) => s.metric === incident.metric);
        if (now !== undefined && now.amount === incident.amountLimit) continue;
        if (now?.level === 'hard') continue;
        if (this.deps.limits.transition(incident.id, 'open', 'dismissed') === null) continue;
        if (incident.approvalId !== null) {
          const card = this.deps.approvals.get(incident.approvalId);
          if (card?.status === 'PENDING') {
            this.deps.approvals.update(card.id, {
              status: 'CANCELLED', decidedAt: this.deps.clock.now(),
              decisionNote: now === undefined ? 'The limit was removed.' : `The limit was changed to ${formatAmount(now.metric, now.amount)}.`,
            });
            this.deps.recorder.invalidate('approvals', card.missionId ?? undefined);
          }
        }
        for (const id of incident.pausedMissionIds) {
          const paused = this.deps.missions.get(id);
          if (paused === undefined || paused.status !== 'PAUSED' || this.refusal(id) !== null) continue;
          this.#setStatus(paused, 'EXECUTING', now === undefined ? 'Limit removed; resumed.' : `Limit changed to ${formatAmount(now.metric, now.amount)}; resumed.`, actorId);
          resumed = true;
        }
      }
      for (const kept of this.deps.missions.list({ workspaceId, statuses: ['PAUSED'] })) {
        if (!isLimitPause(kept.statusReason) || this.refusal(kept.id) !== null) continue;
        this.#setStatus(kept, 'EXECUTING', 'The limit it stopped at was raised; resumed.', actorId);
        resumed = true;
      }
    }));
    this.#stopIfOver(workspaceId);
    this.deps.recorder.invalidate('workspaces');
    if (resumed) this.deps.wake();
  }

  #windowAt(incident: LimitIncident): UsageWindow {
    return { start: incident.windowStart, end: incident.windowEnd ?? this.#window().end, month: incident.windowStart.slice(0, 7) };
  }

  // --------------------------------------------------------------- views

  missionView(mission: Mission): MissionLimitsView {
    const workspace = this.deps.workspaces.get(mission.workspaceId);
    const totals = this.deps.limits.usageForMission(mission.id);
    if (workspace === undefined) return { source: 'none', limits: [], usage: usageView(totals), pendingApprovalId: null };
    const { limits, source } = this.effectiveLimits(mission, workspace);
    const statuses = evaluateLimits(limits, totals);
    const open = this.deps.limits.listByMission(mission.id).find((i) => i.status === 'open' && i.threshold === 'hard' && i.approvalId !== null);
    return {
      source,
      limits: statuses.map((s) => statusView(s, 'mission')),
      usage: usageView(totals),
      pendingApprovalId: open?.approvalId ?? null,
    };
  }

  /** Home's banners: every unfinished mission and the project at or over a warning level. */
  alerts(workspaceId: WorkspaceId): readonly LimitAlertView[] {
    const workspace = this.deps.workspaces.get(workspaceId);
    if (workspace === undefined) return [];
    const alerts: LimitAlertView[] = [];
    const month = this.#monthScope(workspace, null);
    const monthLevel = worstLevel(month.statuses);
    if (monthLevel === 'soft' || monthLevel === 'hard') {
      const status = month.statuses.find((s) => s.level === monthLevel)!;
      alerts.push({
        scope: 'project', missionId: null, missionTitle: null, level: monthLevel,
        text: monthLevel === 'hard'
          ? `${reachedReason(status, 'month')}. Work is paused; raise the monthly limit in the Inbox or in Repositories → Limits.`
          : warningNote(status, 'month'),
      });
    }
    for (const mission of this.deps.missions.list({ workspaceId })) {
      if (mission.status === 'DRAFT' || isTerminalMissionStatus(mission.status)) continue;
      const { limits } = this.effectiveLimits(mission, workspace);
      if (limits.length === 0) continue;
      const scope = this.#missionScope(mission, workspace);
      const level = worstLevel(scope.statuses);
      if (level !== 'soft' && level !== 'hard') continue;
      const status = scope.statuses.find((s) => s.level === level)!;
      alerts.push({
        scope: 'mission', missionId: mission.id, missionTitle: mission.title, level,
        text: level === 'hard'
          ? `${reachedReason(status, 'mission')}. It is paused until you raise the limit or keep it paused.`
          : warningNote(status, 'mission'),
      });
    }
    return alerts;
  }

  usage(workspaceId: WorkspaceId, month?: string): WorkspaceUsageView {
    const workspace = this.deps.workspaces.get(workspaceId);
    if (workspace === undefined) throw TandemiseError.notFound('Workspace', workspaceId);
    const window = month === undefined ? this.#window() : monthWindowOf(month);
    if (window === null) throw TandemiseError.validation(`'${month}' is not a month; a month reads like 2026-09.`, { month });
    const scope = this.#monthScope(workspace, null, window);
    const titles = new Map(this.deps.missions.list({ workspaceId }).map((m) => [m.id as string, m.title]));
    return {
      workspaceId,
      month: window.month,
      windowStart: window.start,
      windowEnd: window.end,
      usage: usageView(scope.totals),
      limits: scope.statuses.map((s) => statusView(s, 'month')),
      defaultMissionLimits: workspace.defaultMissionLimits,
      missions: this.deps.limits.usageByMission(workspaceId, window.start, window.end)
        .map((row) => ({ missionId: row.missionId, title: titles.get(row.missionId) ?? row.missionId, usage: usageView(row.totals) })),
    };
  }

  // --------------------------------------------------------------- helpers

  #setStatus(mission: Mission, status: MissionStatus, reason: string, actorId: string | null = null): void {
    const current = this.deps.missions.get(mission.id) ?? mission;
    if (!canTransition(current.status, status)) return;
    this.deps.missions.update(current.id, { status, statusReason: reason });
    this.deps.recorder.record({ ...this.#scopeOf(current), actorId }, { type: 'mission.status', from: current.status, to: status, reason });
    this.deps.recorder.invalidate('missions', current.id);
  }

  #scopeOf(mission: Mission): EventScope {
    return { workspaceId: mission.workspaceId, missionId: mission.id };
  }
}

function usageView(totals: UsageTotals): UsageView {
  return { agentMinutes: Math.round((totals.agentMs / 60_000) * 100) / 100, tokens: totals.tokens, costUsd: totals.costUsd, runs: totals.runs };
}

function statusView(status: LimitStatus, scope: 'mission' | 'month'): LimitStatusView {
  const note = status.level === 'unmeasured'
    ? 'Cost: not reported. This runtime does not report cost, so this limit cannot be measured and never stops work.'
    : status.level === 'hard'
      ? `${reachedReason(status, scope)}. Work is paused until the limit is raised.`
      : status.level === 'soft'
        ? `Over ${status.warnPercent}%: work stops at ${formatAmount(status.metric, status.amount)}.`
        : null;
  return { ...status, label: metricLabel(status.metric), bar: barLabel(status), note };
}
