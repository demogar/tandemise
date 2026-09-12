import type {
  ApprovalRepositoryPort, Mission, MissionRepositoryPort, MissionStatus, MissionTask,
  TaskRepositoryPort, WorkspaceRepositoryPort,
  RepoRepositoryPort,
} from '@tandemise/domain';
import {
  ACTIVE_TASK_STATUSES, canTransition, isTaskFinished, isTaskParked, isTerminalMissionStatus,
} from '@tandemise/domain';
import type { Clock, Logger, MissionId, TaskId } from '@tandemise/shared';
import { errorMessage } from '@tandemise/shared';
import type { LifecycleComponent } from '@tandemise/kernel';
import type { Waiter } from './waiter.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import type { BranchIntegrationService } from './branch-integration.js';
import type { RemediationPlanner } from './remediation.js';
import type { TaskAttemptOutcome, TaskExecutor } from './task-executor.js';

/** Mission statuses in which the scheduler is allowed to dispatch work. */
const DISPATCHABLE: readonly MissionStatus[] = ['EXECUTING', 'REVIEWING', 'QA', 'READY_TO_SHIP'];

export interface SchedulerDeps {
  readonly workspaces: WorkspaceRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly approvals: ApprovalRepositoryPort;
  readonly executor: TaskExecutor;
  /** Repositories, so a wait polls in the right checkout. */
  readonly repositories: RepoRepositoryPort;
  readonly waiter: Waiter;
  readonly remediation: RemediationPlanner;
  readonly integration: BranchIntegrationService;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
  readonly tickIntervalMs?: number;
}

/**
 * The tick loop (APPLICATION_DESIGN.md §Services to build).
 *
 * Everything the scheduler knows it re-reads from the database on every tick.
 * There is no in-memory model of "what the missions are doing" to drift out of
 * step with the rows, which is what makes a restart mid-mission a non-event:
 * the next tick sees exactly what the previous daemon left behind, and recovery
 * has already reconciled whatever was in flight.
 *
 * The only in-memory state is what genuinely cannot be persisted - the
 * `AbortController` for a run happening *in this process*, and the earliest
 * time a backed-off task may be retried. Both are safe to lose.
 *
 * A tick never blocks on a run. `#dispatch` starts an attempt and returns; the
 * attempt settles itself into the database and the next tick observes the
 * result. That is what lets `stop()` be honest: it aborts every controller it
 * holds and waits for the attempts to unwind, so no worker is orphaned.
 */
export class SchedulerService implements LifecycleComponent {
  readonly name = 'scheduler';

  readonly #active = new Map<TaskId, AbortController>();
  /** In-flight waits, which are deliberately not workers. */
  readonly #waiting = new Map<TaskId, AbortController>();
  readonly #inFlight = new Set<Promise<void>>();
  readonly #retryAfter = new Map<TaskId, number>();
  /** Missions whose task branches have already been merged, so it happens once. */
  readonly #integrated = new Set<MissionId>();
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #ticking = false;
  #wakeRequested = false;

  constructor(private readonly deps: SchedulerDeps) {}

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    const interval = Math.max(100, this.deps.tickIntervalMs ?? 1_500);
    this.#timer = setInterval(() => void this.#safeTick(), interval);
    // `unref` so a scheduler with nothing to do never keeps the process alive;
    // the daemon's HTTP server is what holds the event loop open.
    this.#timer.unref();
    this.deps.log.info('scheduler.started', { tickIntervalMs: interval });
    await this.#safeTick();
  }

  /**
   * Stops dispatching and cancels whatever this process is running.
   *
   * Aborting is not optional politeness: the abort signal is what terminates
   * the worker's child process. Returning from `stop()` with a run still
   * streaming would leave an agent writing into a worktree that nothing is
   * supervising any more (MVP.md §7.3).
   */
  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    for (const controller of this.#active.values()) controller.abort();
    // A wait can outlive every worker, so stopping has to cancel it too or
    // shutdown blocks until a CI run someone else is doing finishes.
    for (const controller of this.#waiting.values()) controller.abort();
    await this.drain();
    this.deps.log.info('scheduler.stopped');
  }

  /** Waits for every attempt started in this process to finish unwinding. */
  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
  }

  /** Asks for a tick as soon as the current one finishes. */
  wake(): void {
    this.#wakeRequested = true;
    if (!this.#ticking) void this.#safeTick();
  }

  activeTaskIds(): readonly TaskId[] {
    return [...this.#active.keys()];
  }

  cancelMission(missionId: MissionId): void {
    for (const task of this.deps.tasks.listByMission(missionId)) this.cancelTask(task.id);
  }

  cancelTask(taskId: TaskId): void {
    this.#active.get(taskId)?.abort();
  }

  /**
   * One pass: promote what is ready, dispatch what fits, reconcile each mission.
   *
   * Re-entrant calls collapse into a single pass plus a follow-up, so a burst of
   * `wake()` calls from the API cannot start the same task twice.
   */
  async tick(): Promise<void> {
    if (this.#ticking) {
      this.#wakeRequested = true;
      return;
    }
    this.#ticking = true;
    try {
      do {
        this.#wakeRequested = false;
        await this.#pass();
      } while (this.#wakeRequested && this.#running);
    } finally {
      this.#ticking = false;
    }
  }

  async #pass(): Promise<void> {
    const missions = this.deps.missions
      .list({ statuses: DISPATCHABLE })
      .filter((m) => !isTerminalMissionStatus(m.status));

    for (const mission of missions) {
      this.#promoteReady(mission);
      this.#dispatchFor(mission);
    }
    // Reconciliation reads the state dispatch just wrote, so it runs after -
    // and after the loop, so a mission whose last task finished during this
    // pass is completed in this pass rather than one tick later.
    for (const mission of missions) {
      await this.#reconcile(this.deps.missions.get(mission.id) ?? mission);
    }
  }

  // ------------------------------------------------------------------ readiness

  /**
   * PENDING → READY once every dependency has succeeded (or was deliberately
   * skipped), PENDING → BLOCKED when a dependency can never succeed.
   *
   * A failed dependency has to block rather than be ignored: running a QA task
   * whose implementation failed produces a report about code that was never
   * written.
   */
  #promoteReady(mission: Mission): void {
    const tasks = this.deps.tasks.listByMission(mission.id);
    const byKey = new Map(tasks.map((t) => [t.key, t]));
    const scope = scopeOf(mission);

    for (const task of tasks) {
      if (task.status !== 'PENDING') continue;

      const missing = task.dependsOn.filter((key) => !byKey.has(key));
      if (missing.length > 0) {
        this.#setStatus(task, scope, 'BLOCKED', `Depends on unknown task(s): ${missing.join(', ')}.`);
        continue;
      }
      const dependencies = task.dependsOn.map((key) => byKey.get(key)!);
      const dead = dependencies.filter((d) => d.status === 'FAILED' || d.status === 'CANCELLED');
      if (dead.length > 0) {
        this.#setStatus(
          task, scope, 'BLOCKED',
          `Blocked by ${dead.map((d) => `${d.key} (${d.status})`).join(', ')}.`,
        );
        continue;
      }
      const satisfied = dependencies.every((d) => d.status === 'SUCCEEDED' || d.status === 'SKIPPED');
      if (satisfied) this.#setStatus(task, scope, 'READY', null);
    }
  }

  // ------------------------------------------------------------------ dispatch

  #dispatchFor(mission: Mission): void {
    const workspace = this.deps.workspaces.get(mission.workspaceId);
    if (workspace === undefined) return;

    const ceiling = Math.max(1, workspace.concurrency.maxTotalWorkers);
    const now = this.deps.clock.epochMs();

    const ready = this.deps.tasks
      .listByMission(mission.id)
      .filter((t) => t.status === 'READY')
      .filter((t) => !this.#active.has(t.id))
      .filter((t) => (this.#retryAfter.get(t.id) ?? 0) <= now)
      .sort((a, b) => a.orderHint - b.orderHint || a.key.localeCompare(b.key));

    for (const task of ready) {
      // A person's task never occupies a worker slot, and is parked before the
      // ceiling is consulted: waiting on a human is not a reason to stop
      // dispatching the agent work that can proceed alongside it.
      if (task.executor === 'human') {
        this.#setStatus(task, scopeOf(mission), 'AWAITING_HUMAN', 'Waiting for you to do this one.');
        continue;
      }
      // A wait holds no model and no worker slot: it is one command on an
      // interval. Counting it against the ceiling would let a twenty-minute
      // deploy wait block agent work that could run alongside it.
      if (task.executor === 'wait') {
        this.#startWait(mission, task);
        continue;
      }
      if (this.#occupiedSlots() >= ceiling) return;
      this.#dispatch(mission, task);
    }
  }

  /**
   * Workers actually competing for the machine.
   *
   * A run blocked inside `ask_human` is still in `#active` - it has to be, or
   * `stop()` and `cancelTask()` could not abort it - but it is parked on a
   * person and consuming nothing. Counting it would let one unanswered question
   * stall every other task in the mission, which is the opposite of what asking
   * is for. The status is read from the row rather than tracked here, in keeping
   * with the scheduler holding no model of its own.
   */
  #occupiedSlots(): number {
    let occupied = 0;
    for (const taskId of this.#active.keys()) {
      const status = this.deps.tasks.get(taskId)?.status;
      if (status === undefined || !isTaskParked(status)) occupied++;
    }
    return occupied;
  }

  /**
   * Starts a wait, outside the concurrency ceiling.
   *
   * Tracked in its own map so `stop()` can cancel it and so the scheduler knows
   * a wait is in flight without treating it as a worker.
   */
  #startWait(mission: Mission, task: MissionTask): void {
    const policy = task.waitPolicy;
    if (policy === null) {
      this.#setStatus(task, scopeOf(mission), 'BLOCKED',
        `Task '${task.key}' is a wait step but names nothing to wait for.`);
      return;
    }

    const controller = new AbortController();
    this.#waiting.set(task.id, controller);
    this.#setStatus(task, scopeOf(mission), 'AWAITING_EXTERNAL', `Waiting: ${policy.command}`);

    const repository = task.repositoryId === null
      ? (mission.repositoryId === null ? null : this.deps.repositories.get(mission.repositoryId) ?? null)
      : this.deps.repositories.get(task.repositoryId) ?? null;

    void this.deps.waiter
      .wait(task, policy, repository, controller.signal)
      .then((outcome) => {
        const current = this.deps.tasks.get(task.id) ?? task;
        if (outcome.kind === 'cancelled') return;
        if (outcome.kind === 'passed') {
          this.#setStatus(current, scopeOf(mission), 'SUCCEEDED', outcome.detail);
          this.deps.tasks.update(task.id, { finishedAt: this.deps.clock.now() });
        } else {
          this.#setStatus(current, scopeOf(mission), 'FAILED', outcome.detail);
          this.deps.tasks.update(task.id, { finishedAt: this.deps.clock.now() });
        }
        this.deps.recorder.invalidate('tasks', mission.id);
      })
      .catch((e: unknown) => {
        this.#setStatus(this.deps.tasks.get(task.id) ?? task, scopeOf(mission), 'BLOCKED',
          `The wait failed outside the poll: ${errorMessage(e)}`);
      })
      .finally(() => {
        this.#waiting.delete(task.id);
      });
  }

  #dispatch(mission: Mission, task: MissionTask): void {
    const controller = new AbortController();
    this.#active.set(task.id, controller);
    this.#retryAfter.delete(task.id);

    const attempt = this.deps.executor
      .execute(task.id, controller.signal)
      .then((outcome) => this.#settled(mission, task, outcome))
      .catch((e: unknown) => {
        // The executor already settles its own failures; reaching here means the
        // attempt threw outside that path, so the task would otherwise sit in
        // RUNNING forever.
        this.deps.log.error('scheduler.attempt_threw', {
          missionId: mission.id, taskId: task.id, error: errorMessage(e),
        });
        this.#setStatus(
          this.deps.tasks.get(task.id) ?? task, scopeOf(mission), 'BLOCKED',
          `The attempt failed outside the run: ${errorMessage(e)}`,
        );
      })
      .finally(() => {
        this.#active.delete(task.id);
        this.#inFlight.delete(attempt);
      });

    this.#inFlight.add(attempt);
  }

  #settled(mission: Mission, task: MissionTask, outcome: TaskAttemptOutcome): void {
    if (outcome.kind === 'deferred') {
      // Contention, not failure. Hold the slot open for a moment so a pair of
      // tasks fighting over one resource do not spin against each other.
      this.#retryAfter.set(task.id, this.deps.clock.epochMs() + 1_000);
      return;
    }
    if (outcome.retryAfterMs !== undefined) {
      this.#retryAfter.set(task.id, this.deps.clock.epochMs() + outcome.retryAfterMs);
    }
    if (outcome.status !== 'SUCCEEDED') return;

    // Loopback: a review or QA task that found blocking problems becomes work.
    const settledTask = this.deps.tasks.get(task.id);
    if (settledTask === undefined) return;
    if (!settledTask.expectedOutputs.some((t) => t === 'ReviewReport' || t === 'QAReport')) return;

    const current = this.deps.missions.get(mission.id) ?? mission;
    const planned = this.deps.remediation.plan(settledTask, current);
    if (planned.kind === 'planned') {
      this.deps.log.info('scheduler.remediation_planned', {
        missionId: mission.id, taskId: task.id, fix: planned.fixKey, findings: planned.findings,
      });
    }
  }

  // --------------------------------------------------------------- reconcile

  /**
   * Decides what the mission as a whole is now doing.
   *
   * "Stalled" is defined structurally rather than by counting failures: if no
   * task is in an active status, nothing will move again without a human,
   * whatever the individual statuses say. A task waiting on a person counts as
   * active - the mission is not stuck, it is waiting, and calling that BLOCKED
   * would report a problem where there is only a queue. That covers the
   * cases a status-counting rule misses - a PENDING task whose dependency is
   * blocked, a mission whose only remaining work is behind a rejected approval.
   */
  async #reconcile(mission: Mission): Promise<void> {
    if (isTerminalMissionStatus(mission.status)) return;
    const tasks = this.deps.tasks.listByMission(mission.id);
    if (tasks.length === 0) return;

    if (tasks.every((t) => isTaskFinished(t.status))) {
      await this.#finish(mission, tasks);
      return;
    }

    const movable = tasks.some((t) => ACTIVE_TASK_STATUSES.includes(t.status));
    if (!movable && this.#active.size === 0) {
      const stuck = tasks.filter((t) => t.status === 'BLOCKED');
      this.#setMissionStatus(
        mission, 'BLOCKED',
        stuck.length > 0
          ? `Waiting on ${stuck.map((t) => t.key).join(', ')}: ${stuck[0]?.statusReason ?? 'no reason recorded'}`
          : 'No task can make progress without human intervention.',
      );
    }
  }

  async #finish(mission: Mission, tasks: readonly MissionTask[]): Promise<void> {
    const failed = tasks.filter((t) => t.status === 'FAILED');
    if (failed.length > 0) {
      this.#setMissionStatus(
        mission, 'FAILED',
        `${failed.length} task(s) failed: ${failed.map((t) => t.key).join(', ')}.`,
      );
      return;
    }

    // Integration before completion: merging can insert a conflict-resolution
    // task, and a mission marked COMPLETE with unmerged work is a lie.
    if (!this.#integrated.has(mission.id)) {
      this.#integrated.add(mission.id);
      try {
        const outcome = await this.deps.integration.integrate(mission);
        if (outcome.conflictTaskKey !== null) {
          this.deps.log.warn('scheduler.integration_conflict', {
            missionId: mission.id, task: outcome.conflictTaskKey,
          });
          // The new task is PENDING; the next tick promotes and runs it.
          return;
        }
      } catch (e) {
        this.deps.recorder.note(
          scopeOf(mission), `Branch integration failed: ${errorMessage(e)}`, 'error',
        );
        this.#setMissionStatus(mission, 'BLOCKED', `Branch integration failed: ${errorMessage(e)}`);
        return;
      }
    }

    const skipped = tasks.filter((t) => t.status === 'SKIPPED').length;
    this.#setMissionStatus(
      mission, 'COMPLETE',
      skipped === 0 ? 'Every task succeeded.' : `Every task succeeded; ${skipped} were skipped.`,
    );
    this.deps.missions.update(mission.id, { completedAt: this.deps.clock.now() });
  }

  // ------------------------------------------------------------- transitions

  #setStatus(task: MissionTask, scope: EventScope, status: MissionTask['status'], reason: string | null): void {
    if (task.status === status && task.statusReason === reason) return;
    this.deps.tasks.update(task.id, { status, statusReason: reason });
    this.deps.recorder.record({ ...scope, taskId: task.id, roleId: task.roleId }, {
      type: 'task.status',
      from: task.status,
      to: status,
      ...(reason === null ? {} : { reason }),
    });
    this.deps.recorder.invalidate('tasks', task.missionId);
  }

  #setMissionStatus(mission: Mission, status: MissionStatus, reason: string): void {
    if (mission.status === status) return;
    if (!canTransition(mission.status, status)) {
      this.deps.log.warn('scheduler.illegal_transition', {
        missionId: mission.id, from: mission.status, to: status,
      });
      return;
    }
    this.deps.missions.update(mission.id, { status, statusReason: reason });
    this.deps.recorder.record(scopeOf(mission), {
      type: 'mission.status', from: mission.status, to: status, reason,
    });
    this.deps.recorder.invalidate('missions', mission.id);
  }

  async #safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (e) {
      // A scheduler that dies on one bad mission stops every other mission too.
      this.deps.log.error('scheduler.tick_failed', { error: errorMessage(e) });
    }
  }
}

function scopeOf(mission: Mission): EventScope {
  return { workspaceId: mission.workspaceId, missionId: mission.id };
}
