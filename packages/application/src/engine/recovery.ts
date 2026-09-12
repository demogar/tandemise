import type {
  ExecutionTargetRepositoryPort, LeaseRepositoryPort, MissionRepositoryPort, Run,
  RunRepositoryPort, RunStatus, RuntimeProfileRepositoryPort, TaskRepositoryPort,
} from '@tandemise/domain';
import type { RuntimeRegistry } from '@tandemise/runtimes-core';
import type { Clock, Logger, MissionId, RunId } from '@tandemise/shared';
import type { ProcessLivenessPort } from '../ports.js';
import type { EventRecorder } from '../support/event-recorder.js';

export interface RecoveryReport {
  readonly adopted: readonly string[];
  readonly resumable: readonly string[];
  readonly interrupted: readonly string[];
  readonly tasksRequeued: number;
  readonly leasesReleased: number;
  readonly targetsFailed: number;
  readonly missionsTouched: readonly MissionId[];
}

/**
 * Startup recovery (MVP.md §21.2, APPLICATION_DESIGN.md §Recovery).
 *
 * The daemon is a supervisor of other people's processes, so "what was running
 * when I died?" is a question it must answer before it does anything else.
 * `SchedulerService.start()` must not be reached until this has run: dispatching
 * into a world where a previous worker is still alive is how two agents end up
 * writing the same worktree.
 *
 * Migrations and the single-instance lock (steps 1 and 2 of the design) are the
 * composition root's, not this class's - they have to happen before the
 * database is even opened, which is before anything here can be constructed.
 *
 * The rule throughout is *verify before acting*. A lease is released only after
 * its holder is confirmed dead; a run is marked INTERRUPTED only after its pid
 * is confirmed gone. Guessing in the other direction restarts work that is
 * still running.
 */
export class RecoveryService {
  constructor(
    private readonly missions: MissionRepositoryPort,
    private readonly tasks: TaskRepositoryPort,
    private readonly runs: RunRepositoryPort,
    private readonly targets: ExecutionTargetRepositoryPort,
    private readonly leases: LeaseRepositoryPort,
    private readonly runtimeProfiles: RuntimeProfileRepositoryPort,
    private readonly registry: RuntimeRegistry,
    private readonly liveness: ProcessLivenessPort,
    private readonly recorder: EventRecorder,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  run(): RecoveryReport {
    const adopted: string[] = [];
    const resumable: string[] = [];
    const interrupted: string[] = [];
    const touched = new Set<MissionId>();
    let tasksRequeued = 0;

    for (const run of this.runs.listByStatus(['STARTING', 'RUNNING'])) {
      if (run.pid !== null && this.liveness.isAlive(run.pid)) {
        // Still running under a pid we recorded. Leave it: the previous
        // daemon's child is doing real work, and killing it would discard it.
        adopted.push(run.id);
        continue;
      }

      const status = this.#classify(run);
      this.runs.update(run.id, {
        status,
        finishedAt: this.clock.now(),
        errorCode: status,
        errorMessage: status === 'RESUMABLE'
          ? 'The daemon exited mid-run; the runtime session can be resumed.'
          : 'The daemon exited mid-run and the worker process is gone.',
      });
      (status === 'RESUMABLE' ? resumable : interrupted).push(run.id);
      touched.add(run.missionId);

      // The attempt count is preserved on purpose: an interrupted attempt was
      // an attempt, and pretending otherwise would let a task that fails by
      // crashing loop past its retry budget.
      const task = this.tasks.get(run.taskId);
      if (task !== undefined && task.status === 'RUNNING') {
        this.tasks.update(task.id, {
          status: 'READY',
          statusReason: status === 'RESUMABLE'
            ? 'The previous run was interrupted and can be resumed.'
            : 'The previous run was interrupted before it finished.',
        });
        tasksRequeued += 1;
      }
    }

    const leasesReleased = this.#releaseDeadLeases();
    const targetsFailed = this.#failOrphanedTargets(touched);

    for (const missionId of touched) {
      const mission = this.missions.get(missionId);
      if (mission === undefined) continue;
      this.recorder.note(
        { workspaceId: mission.workspaceId, missionId },
        `Tandemise restarted while this mission was running. `
        + `${resumable.length} run(s) can be resumed, ${interrupted.length} were interrupted; `
        + `affected tasks were returned to the queue.`,
        'warn',
      );
    }

    const report: RecoveryReport = {
      adopted, resumable, interrupted, tasksRequeued, leasesReleased, targetsFailed,
      missionsTouched: [...touched],
    };
    this.log.info('recovery.complete', { ...report, missionsTouched: report.missionsTouched.length });
    this.recorder.invalidate('missions');
    this.recorder.invalidate('tasks');
    return report;
  }

  /**
   * Resumable needs two things at once: a runtime that can resume, and a
   * session handle it can resume *from*. Either alone is not enough, and
   * claiming resumability without both produces a retry that silently starts
   * from scratch while telling the user it continued.
   */
  #classify(run: Run): RunStatus {
    const profile = this.runtimeProfiles.get(run.runtimeProfileId);
    const adapter = profile === undefined ? undefined : this.registry.tryAdapter(profile.adapterId);
    const canResume = adapter?.resume !== undefined && run.externalSessionId !== null;
    return canResume ? 'RESUMABLE' : 'INTERRUPTED';
  }

  #releaseDeadLeases(): number {
    let released = 0;
    const now = this.clock.now();
    const expired = new Set(this.leases.listExpired(now).map((l) => l.id));

    for (const lease of this.leases.listAll()) {
      const holder = lease.holderRunId === null ? undefined : this.runs.get(lease.holderRunId as RunId);
      const holderAlive = holder !== undefined
        && (holder.status === 'STARTING' || holder.status === 'RUNNING')
        && holder.pid !== null
        && this.liveness.isAlive(holder.pid);

      if (holderAlive) continue;
      if (lease.holderRunId === null && !expired.has(lease.id)) {
        // Held by a task rather than a run and not yet expired: this daemon has
        // no process to check, so the TTL is the only safe arbiter.
        continue;
      }
      this.leases.release(lease.id);
      released += 1;
    }
    return released;
  }

  #failOrphanedTargets(touched: Set<MissionId>): number {
    let failed = 0;
    for (const target of this.targets.listByStatus(['PROVISIONING'])) {
      this.targets.update(target.id, {
        status: 'FAILED',
        detail: 'Provisioning was interrupted by a daemon restart.',
      });
      if (target.missionId !== null) touched.add(target.missionId);
      failed += 1;
    }
    if (failed > 0) this.recorder.invalidate('targets');
    return failed;
  }
}
