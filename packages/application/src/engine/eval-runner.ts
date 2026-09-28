import type {
  ArtifactRepositoryPort, ArtifactStorePort, EvalBlobPort, EvalCase, EvalRepositoryPort, EvalRun, EvalRunStatus, EvalTrial,
  EvalTrialStatus, ExecutionTargetRecord, ExecutionTargetRepositoryPort, Mission, MissionCriteriaRepositoryPort, MissionRepositoryPort, MissionStatus,
  MissionTask, ModelPolicy, RepoRepositoryPort, RunRepositoryPort, RunScoreRepositoryPort, SkillPin, TaskRepositoryPort,
  TaskStatus, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { NO_APPROVAL } from '@tandemise/domain';
import { scoreEvalRun, trialScoreFrom, type Scorecard } from '@tandemise/evaluation';
import type { ExecutionTargetManager } from '@tandemise/execution-core';
import type { CommandExecutor } from '@tandemise/integrations-core';
import type { LifecycleComponent } from '@tandemise/kernel';
import type { Clock, EvalRunId, EvalTrialId, Logger, MissionId, TaskId } from '@tandemise/shared';
import { errorMessage, ids, slugify } from '@tandemise/shared';
import { DaemonStopping, isDaemonStopping } from '../support/shutdown.js';
import type { TaskAttemptOutcome, TrialContext } from './task-executor.js';

/** Why a run the daemon stopped in the middle of is failed at the next boot (Global Constraints copy). */
export const DAEMON_STOPPED_REASON = 'The daemon stopped during this run.';

/** Why a trial a cancel stopped before it ever started is cancelled. */
export const CANCELLED_BEFORE_START_REASON = 'Cancelled before it started.';

/** The cap copy, with the cap as the Limits screen shows money: two decimals. */
export function stoppedAtCapReason(capUsd: number): string {
  return `Stopped at your $${capUsd.toFixed(2)} cap`;
}

/** How long a trial may keep being deferred (no runtime slot, say) before it ends blocked. */
const MAX_DEFERRAL_MS = 10 * 60_000;
/** A deferral that names no wait is offered again after this long. */
const DEFAULT_DEFER_MS = 5_000;
/** With nothing to run, the loop looks again this often even if nobody wakes it. */
const IDLE_MS = 5_000;
const GIT_TIMEOUT_MS = 30_000;
const ENDED_TASK_STATUSES: readonly TaskStatus[] = ['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED', 'SKIPPED'];

/** What the runner needs of the executor: one attempt at one task. */
export interface TrialExecutor {
  execute(taskId: TaskId, signal: AbortSignal): Promise<TaskAttemptOutcome>;
}

export interface EvalRunnerDeps {
  readonly evals: EvalRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly runs: RunRepositoryPort;
  readonly runScores: RunScoreRepositoryPort;
  readonly criteria: MissionCriteriaRepositoryPort;
  readonly artifacts: ArtifactRepositoryPort;
  readonly artifactStore: ArtifactStorePort;
  readonly blobs: EvalBlobPort;
  readonly repositories: RepoRepositoryPort;
  readonly workspaces: WorkspaceRepositoryPort;
  readonly targets: ExecutionTargetRepositoryPort;
  readonly targetManager: ExecutionTargetManager;
  readonly executor: TrialExecutor;
  /** Raw git, for deleting a trial's branch; null in a build without one (the branch is then left). */
  readonly exec: CommandExecutor | null;
  readonly clock: Clock;
  readonly log: Logger;
  /** Waits `ms`, ending early when `signal` aborts. Injectable so a check can pass time without waiting. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** What an eval run has spent so far, over the runs of every trial mission it made. */
export interface EvalSpend {
  /** The sum of every reported cost: a lower bound when `costUnmeasured`, never a guess for the rest. */
  readonly measuredUsd: number;
  /** True when a finished run reported no cost (Ruling 9): an unknown cost is never $0. */
  readonly costUnmeasured: boolean;
}

/** Spend over `trials`' missions: every finished run's reported cost. */
export function evalSpend(runs: Pick<RunRepositoryPort, 'listByMission'>, trials: readonly EvalTrial[]): EvalSpend {
  let measured = 0;
  let unmeasured = false;
  for (const trial of trials) {
    if (trial.missionId === null) continue;
    for (const run of runs.listByMission(trial.missionId)) {
      if (run.status === 'STARTING' || run.status === 'RUNNING') continue;
      const cost = run.usage?.costUsd;
      if (cost === undefined || cost === null) unmeasured = true;
      else measured += cost;
    }
  }
  return { measuredUsd: measured, costUnmeasured: unmeasured };
}

/** The scorecard over a run's trials as they stand: only finished trials count toward it. */
export function scorecardFor(evals: EvalRepositoryPort, run: EvalRun): Scorecard {
  const names = new Map(evals.listCases(run.suiteId).map((c) => [c.id as string, c.name]));
  return scoreEvalRun(
    evals.listTrials(run.id).map((t) => ({
      caseId: t.caseId, caseName: names.get(t.caseId) ?? t.caseId, variant: t.variant, status: t.status, score: t.score,
    })),
    run.repeats,
  );
}

/** The live trial: the one attempt this process is driving, and how to stop it. */
interface LiveTrial {
  readonly runId: EvalRunId;
  readonly trialId: EvalTrialId;
  readonly controller: AbortController;
}

/** How the step's attempts ended, before it is scored. */
type TrialEnd =
  | { readonly kind: 'stopping' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'settled'; readonly status: TaskStatus; readonly reason: string | null };

/**
 * Runs eval trials, one at a time (P3b spec Part B, §B4).
 *
 * Each trial is a hidden mission that replays one saved case: the case's
 * inputs seeded as finished upstream work, its Done-when ledger, and one step
 * task written so that nothing in it can reach a person - no approval, no
 * staffing, failing outright when its attempts run out. The executor drives
 * the step exactly as it drives any other; the trial's frozen role, knowledge
 * and answers reach it through `contextFor`. After each trial the worktree and
 * its branch are removed, so a run of dozens of trials leaves nothing behind.
 *
 * All state is in the eval repository. The only in-memory state is the live
 * trial's abort controller and a small cache of its context - both safe to
 * lose, because a run the daemon stopped mid-way is failed at the next boot
 * (`recoverInterrupted`), never resumed: half a run's trials on one build and
 * half on another would not compare like with like.
 */
export class EvalRunner implements LifecycleComponent {
  readonly name = 'eval-runner';

  #running = false;
  #loop: Promise<void> | undefined;
  #live: LiveTrial | undefined;
  #wakeRequested = false;
  #wakeIdle: (() => void) | undefined;
  /** The live trial's context, asked for on every attempt and prompt compile. Keyed by trial id. */
  readonly #contexts = new Map<string, TrialContext>();

  constructor(private readonly deps: EvalRunnerDeps) {}

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    // Not awaited: the loop runs for the daemon's life, and startup must not wait on a trial.
    this.#loop = this.#runLoop();
    this.deps.log.info('eval.runner_started');
  }

  async stop(): Promise<void> {
    this.#running = false;
    // Stopping, not cancelling: the trial is left `running` for boot recovery to fail the run.
    this.#live?.controller.abort(new DaemonStopping());
    this.#wakeIdle?.();
    await this.#loop;
    this.#loop = undefined;
    this.deps.log.info('eval.runner_stopped');
  }

  wake(): void {
    this.#wakeRequested = true;
    this.#wakeIdle?.();
  }

  cancel(runId: EvalRunId): void {
    if (this.#live?.runId === runId) this.#live.controller.abort();
  }

  contextFor(mission: Mission): TrialContext | null {
    const trialId = mission.evalTrialId;
    if (trialId === undefined || trialId === null) return null;
    const cached = this.#contexts.get(trialId);
    if (cached !== undefined) return cached;
    const trial = this.deps.evals.getTrial(trialId);
    const run = trial === undefined ? undefined : this.deps.evals.getRun(trial.runId);
    const kase = trial === undefined ? undefined : this.deps.evals.getCase(trial.caseId);
    if (trial === undefined || run === undefined || kase === undefined) return null;
    const variantRole = run.variants[trial.variant]?.roles[kase.snapshot.step.roleId];
    if (variantRole === undefined) return null;
    const { knowledge, decisions, answers } = kase.snapshot.mission;
    const context: TrialContext = { role: variantRole.role, knowledge, decisions, answers };
    // Only the live trial is cached: any other is read from the repositories, and the cache never grows.
    if (this.#live?.trialId === trialId) this.#contexts.set(trialId, context);
    return context;
  }

  async recoverInterrupted(): Promise<void> {
    for (const run of this.deps.evals.activeRuns()) {
      // A queued run never started; it simply starts when the loop does.
      if (run.status !== 'running') continue;
      try {
        for (const trial of this.deps.evals.listTrials(run.id)) {
          if (trial.status === 'running') await this.#abandon(trial, run, DAEMON_STOPPED_REASON);
          else if (trial.status === 'queued') this.#endTrial(trial.id, 'cancelled', null, null);
        }
        this.#finishRun(run, 'failed', DAEMON_STOPPED_REASON);
        this.deps.log.warn('eval.run_interrupted', { runId: run.id });
      } catch (e) {
        this.deps.log.error('eval.recovery_failed', { runId: run.id, error: errorMessage(e) });
        // Left `running`, the loop would resume a run whose trial state is unknown. It is failed
        // with no scorecard rather than not at all.
        try {
          this.deps.evals.updateRun(run.id, { status: 'failed', reason: DAEMON_STOPPED_REASON, finishedAt: this.deps.clock.now() });
        } catch (again) {
          this.deps.log.error('eval.recovery_failed', { runId: run.id, error: errorMessage(again) });
        }
      }
    }
  }

  // ------------------------------------------------------------------ the loop

  async #runLoop(): Promise<void> {
    while (this.#running) {
      this.#wakeRequested = false;
      const run = this.deps.evals.activeRuns()[0];
      if (run === undefined) {
        await this.#idle();
        continue;
      }
      try {
        await this.#drive(run);
      } catch (e) {
        // A run that throws is ended, not retried: looping on it would spin forever.
        this.deps.log.error('eval.run_failed', { runId: run.id, error: errorMessage(e) });
        if (!this.#running) return;
        // Its own guard: a throw here would reject the loop and leave the runner dead with nobody told.
        try {
          const current = this.deps.evals.getRun(run.id);
          if (current !== undefined && (current.status === 'queued' || current.status === 'running')) {
            this.#cancelQueued(run.id, CANCELLED_BEFORE_START_REASON);
            this.#finishRun(current, 'failed', `The eval run stopped: ${errorMessage(e)}`);
          }
        } catch (again) {
          this.deps.log.error('eval.run_end_failed', { runId: run.id, error: errorMessage(again) });
          // Not idle-free: a run that can be neither driven nor ended would otherwise spin the loop.
          await this.#idle();
        }
      }
    }
  }

  /** Waits for `wake()`, `stop()` or the idle interval, whichever is first. */
  #idle(): Promise<void> {
    if (this.#wakeRequested || !this.#running) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (): void => {
        clearTimeout(timer);
        this.#wakeIdle = undefined;
        resolve();
      };
      timer = setTimeout(done, IDLE_MS);
      // Never what keeps the process alive: the daemon's HTTP server is.
      timer.unref();
      this.#wakeIdle = done;
    });
  }

  async #drive(queued: EvalRun): Promise<void> {
    let run = queued;
    if (run.status === 'queued') run = this.deps.evals.updateRun(run.id, { status: 'running', startedAt: this.deps.clock.now() });
    for (;;) {
      if (!this.#running) return;
      // Re-read every time: a person may have cancelled the run while the last trial ran.
      const current = this.deps.evals.getRun(run.id);
      if (current === undefined || current.status !== 'running') return;
      const next = this.deps.evals.listTrials(run.id).find((t) => t.status === 'queued');
      if (next === undefined) break;
      const ended = await this.#runTrial(current, next);
      if (ended === 'stopping') return;

      const spend = evalSpend(this.deps.runs, this.deps.evals.listTrials(run.id));
      // The measured spend is a lower bound even when some runs reported no cost (Ruling 9): once it
      // reaches the cap, the cap was reached. What went unmeasured can only make it later; the run says so.
      if (spend.measuredUsd >= current.spendCapUsd) {
        const still = this.deps.evals.getRun(run.id);
        if (still?.status !== 'running') return;
        this.#cancelQueued(run.id, stoppedAtCapReason(current.spendCapUsd));
        this.#finishRun(still, 'stopped_at_cap', stoppedAtCapReason(current.spendCapUsd));
        return;
      }
    }
    const final = this.deps.evals.getRun(run.id);
    if (final?.status === 'running') this.#finishRun(final, 'completed', null);
  }

  // ----------------------------------------------------------------- one trial

  /** Runs one trial to its end, or returns 'stopping' having written nothing more when the daemon is stopping. */
  async #runTrial(run: EvalRun, trial: EvalTrial): Promise<'done' | 'stopping'> {
    const controller = new AbortController();
    this.#live = { runId: run.id, trialId: trial.id, controller };
    this.deps.evals.updateTrial(trial.id, { status: 'running', startedAt: this.deps.clock.now() });
    let missionId: MissionId | null = null;
    let stepTaskId: TaskId | null = null;
    try {
      const kase = this.deps.evals.getCase(trial.caseId);
      if (kase === undefined) {
        this.#endTrial(trial.id, 'failed', 'This case no longer exists.', null);
        return 'done';
      }
      let end: TrialEnd;
      try {
        const setUp = await this.#setUp(run, trial, kase, controller.signal);
        missionId = setUp.missionId;
        stepTaskId = setUp.stepTaskId;
        end = await this.#execute(stepTaskId, controller.signal);
      } catch (e) {
        if (isDaemonStopping(controller.signal)) return 'stopping';
        // Setup can fail after the mission was written; the trial row knows it, so it is still closed and cleaned up.
        missionId = this.deps.evals.getTrial(trial.id)?.missionId ?? null;
        if (controller.signal.aborted) end = { kind: 'cancelled' };
        else {
          this.deps.log.error('eval.trial_failed', { runId: run.id, trialId: trial.id, error: errorMessage(e) });
          end = { kind: 'settled', status: 'FAILED', reason: errorMessage(e) };
        }
      }
      if (end.kind === 'stopping') return 'stopping';

      // Every write from here on is guarded: a throw must still end the trial and remove its
      // worktree, or the trial would read `running` forever and the run could never finish.
      let cleaned = false;
      try {
        const score = stepTaskId === null ? null : trialScoreFrom(this.deps.runScores.listByTask(stepTaskId));
        const [status, reason, missionStatus] = trialOutcome(end);
        // A step the trial ended while it still waited (cancelled between attempts, say) is closed
        // with it, so no hidden task is left looking like work to do.
        const step = stepTaskId === null ? undefined : this.deps.tasks.get(stepTaskId);
        if (step !== undefined && !ENDED_TASK_STATUSES.includes(step.status)) {
          this.deps.tasks.update(step.id, { status: 'CANCELLED', statusReason: reason ?? 'The eval trial ended.' });
        }
        if (missionId !== null) this.deps.missions.update(missionId, { status: missionStatus, statusReason: reason });
        // Before the trial is marked ended, so whoever sees it ended also sees its worktree gone.
        cleaned = true;
        if (missionId !== null) await this.#cleanUp(missionId);
        this.#endTrial(trial.id, status, reason, score);
      } catch (e) {
        this.deps.log.error('eval.trial_end_failed', { runId: run.id, trialId: trial.id, error: errorMessage(e) });
        if (!cleaned && missionId !== null) await this.#cleanUpQuietly(missionId);
        this.#endTrial(trial.id, 'failed', errorMessage(e), null);
      }
      return 'done';
    } finally {
      this.#contexts.delete(trial.id);
      this.#live = undefined;
    }
  }

  /**
   * Writes the trial's hidden mission: the case's ledger, its inputs as
   * finished upstream work, and the step task itself, READY for the executor.
   */
  async #setUp(run: EvalRun, trial: EvalTrial, kase: EvalCase, signal: AbortSignal): Promise<{ missionId: MissionId; stepTaskId: TaskId }> {
    const { snapshot } = kase;
    const { step } = snapshot;
    const variantRole = run.variants[trial.variant].roles[step.roleId];
    if (variantRole === undefined) throw new Error(`This run has no ${trial.variant} setup for the role ${step.roleId}.`);
    const workspace = this.deps.workspaces.get(run.workspaceId);
    const now = this.deps.clock.now();

    const missionId = ids.mission();
    this.deps.missions.create({
      id: missionId,
      workspaceId: run.workspaceId,
      repositoryId: snapshot.repositoryId,
      title: `Eval trial ${kase.name} ${trial.variant} ${trial.repeat}`,
      goal: snapshot.mission.goal,
      constraints: snapshot.mission.constraints,
      successCriteria: [],
      ...(workspace === undefined ? {} : { autonomy: workspace.defaultAutonomyLevel }),
      baseBranch: snapshot.baseSha,
      createdBy: null,
      // Rank 0, not "last in the project": a trial must never take a backlog place from real work.
      rank: 0,
      evalTrialId: trial.id,
    });
    this.deps.evals.updateTrial(trial.id, { missionId });
    this.deps.criteria.seed(missionId, snapshot.criteria);

    // Each input type becomes one finished upstream step holding the case's bytes, so the
    // step reads them exactly as it read the original's upstream output.
    const stubKeys: string[] = [];
    for (const type of [...new Set(snapshot.inputs.map((i) => i.type))]) {
      const stub = this.deps.tasks.add({
        id: ids.task(), missionId, repositoryId: null, executor: 'agent', waitPolicy: null,
        key: `input-${slugify(type)}`, title: `Input: ${type}`, objective: 'Seeded input for an eval trial', roleId: step.roleId,
        dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: [type],
        executionPolicy: { isolation: 'none', maxWallTimeMs: step.maxWallTimeMs, capabilities: [] },
        approvalPolicy: NO_APPROVAL, retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'fail' }, completionGate: null,
        modelPolicy: null, skills: [], staffing: null,
        status: 'SUCCEEDED', statusReason: 'Seeded input for an eval trial', attempts: 0, round: 1,
        remediatesTaskId: null, orderHint: 0, createdAt: now, updatedAt: now, startedAt: now, finishedAt: now,
      });
      stubKeys.push(stub.key);
      for (const input of snapshot.inputs.filter((i) => i.type === type)) {
        const bytes = await this.deps.blobs.get(input.sha256);
        if (signal.aborted) throw signal.reason ?? new Error('aborted');
        if (bytes === null) throw new Error(`An input of case ${kase.name} is missing from the eval store.`);
        const written = await this.deps.artifactStore.write({
          workspaceId: run.workspaceId, missionId, taskId: stub.id, type, title: input.title, body: bytes, mediaType: input.mediaType,
        });
        this.deps.artifacts.create({ ...written, handoff: input.handoff, authorId: null, responsibleId: null, recordedBy: null, round: 1 });
      }
    }

    const role = variantRole.role;
    // The person asked to try this model on this step, so a models candidate replaces the step's own model
    // too - but only for a role it names with a model other than the baseline's. A role it repeats as it
    // is today was not changed, and its step keeps the model it pinned in both variants.
    const named = trial.variant === 'candidate' && run.candidate.kind === 'models'
      ? nonBlank(run.candidate.roles[step.roleId])
      : undefined;
    const candidateModel = named !== undefined && named !== nonBlank(run.variants.baseline.roles[step.roleId]?.role.models?.model)
      ? named
      : undefined;
    const model = nonBlank(candidateModel) ?? nonBlank(step.stepModel) ?? nonBlank(role.models?.model);
    const escalate = step.modelPolicy?.escalate ?? role.models?.escalate;
    const modelPolicy: ModelPolicy = {
      ...(step.modelPolicy ?? {}),
      ...(escalate === undefined ? {} : { escalate }),
      // Pinned, so limit pressure cannot swap in the economy model and mask the candidate (R2b).
      ...(model === undefined ? {} : { model, pinned: true }),
    };
    // A step's own pin wins over the role's of the same name, as when the case was run.
    const stepNames = new Set(step.stepSkills.map((p) => p.name));
    const skills: SkillPin[] = [...variantRole.pins.filter((p) => !stepNames.has(p.name)), ...step.stepSkills];

    const stepTask: MissionTask = this.deps.tasks.add({
      id: ids.task(), missionId, repositoryId: null, executor: 'agent', waitPolicy: null,
      key: step.key, title: step.title, objective: step.objective, roleId: step.roleId,
      dependsOn: stubKeys, requiredCapabilities: step.requiredCapabilities, inputArtifacts: step.inputArtifacts,
      expectedOutputs: step.expectedOutputs,
      executionPolicy: { isolation: 'worktree', maxWallTimeMs: step.maxWallTimeMs, capabilities: [] },
      // Nothing a person would have to answer: no approval, no staffing, and a plain failure when
      // attempts run out - a trial nobody can unblock must end, not wait (Ruling 5).
      approvalPolicy: NO_APPROVAL,
      retryPolicy: { ...step.retryPolicy, onExhausted: 'fail' },
      completionGate: step.completionGate,
      modelPolicy, skills, staffing: null,
      status: 'READY', statusReason: null, attempts: 0, round: 1,
      remediatesTaskId: null, orderHint: 0, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
    });
    return { missionId, stepTaskId: stepTask.id };
  }

  /**
   * Attempts the step until it settles. A retry the executor schedules is
   * waited out here (the scheduler never sees a trial), and so is a deferral,
   * for up to ten minutes before the trial ends blocked with its reason.
   */
  async #execute(taskId: TaskId, signal: AbortSignal): Promise<TrialEnd> {
    const sleep = this.deps.sleep ?? abortableSleep;
    let deferredMs = 0;
    // A cancel or stop that landed while the trial was being set up: never start a run for it.
    if (isDaemonStopping(signal)) return { kind: 'stopping' };
    if (signal.aborted) return { kind: 'cancelled' };
    for (;;) {
      const outcome = await this.deps.executor.execute(taskId, signal);
      if (isDaemonStopping(signal)) return { kind: 'stopping' };
      if (signal.aborted) return { kind: 'cancelled' };
      if (outcome.kind === 'deferred') {
        if (deferredMs >= MAX_DEFERRAL_MS) {
          this.deps.tasks.update(taskId, { status: 'BLOCKED', statusReason: outcome.reason });
          return { kind: 'settled', status: 'BLOCKED', reason: outcome.reason };
        }
        const from = this.deps.clock.epochMs();
        await sleep(outcome.retryAfterMs ?? DEFAULT_DEFER_MS, signal);
        deferredMs += this.deps.clock.epochMs() - from;
      } else if (outcome.status === 'READY' && outcome.retryAfterMs !== undefined) {
        await sleep(outcome.retryAfterMs, signal);
      } else {
        return { kind: 'settled', status: outcome.status, reason: outcome.reason };
      }
      // Stopped or cancelled while waiting for the next attempt.
      if (isDaemonStopping(signal)) return { kind: 'stopping' };
      if (signal.aborted) return { kind: 'cancelled' };
    }
  }

  // ------------------------------------------------------------------ endings

  /** A trial the last daemon left mid-run: its step is cancelled rather than requeued, and its worktree removed. */
  async #abandon(trial: EvalTrial, run: EvalRun, reason: string): Promise<void> {
    if (trial.missionId !== null) {
      for (const task of this.deps.tasks.listByMission(trial.missionId)) {
        if (ENDED_TASK_STATUSES.includes(task.status)) continue;
        this.deps.tasks.update(task.id, { status: 'CANCELLED', statusReason: reason });
      }
      this.deps.missions.update(trial.missionId, { status: 'CANCELLED', statusReason: reason });
      await this.#cleanUp(trial.missionId);
    }
    this.#endTrial(trial.id, 'cancelled', reason, null);
    this.deps.log.info('eval.trial_abandoned', { runId: run.id, trialId: trial.id });
  }

  /**
   * Removes every worktree the trial's mission made, dirty or not, and its
   * branch. A trial's output is a score, not work anyone reviews, so nothing
   * here is worth keeping - and a run of dozens of trials would otherwise
   * leave dozens of branches. A failure is logged; it never changes the score.
   */
  async #cleanUp(missionId: MissionId): Promise<void> {
    const mission = this.deps.missions.get(missionId);
    const repository = mission?.repositoryId === null || mission === undefined ? undefined : this.deps.repositories.get(mission.repositoryId);
    const branches = new Set<string>();
    for (const found of this.deps.targets.listByMission(missionId)) {
      if (found.kind !== 'worktree' || found.status === 'RELEASED' && found.branch === null) continue;
      // The executor records the branch only after `git worktree add` returns, so a daemon that died
      // in between left a worktree on disk under a row with no branch. It is found by the branch
      // the worktree factory names, which only this task's target uses.
      const record = found.branch !== null || mission === undefined || repository === undefined
        ? found
        : await this.#provisionedWorktree(found, mission, repository.path);
      if (record === null || record.branch === null) continue;
      branches.add(record.branch);
      if (record.status === 'RELEASED') continue;
      try {
        await this.deps.targetManager.release(record, { force: true });
        this.deps.targets.update(record.id, { status: 'RELEASED', releasedAt: this.deps.clock.now() });
      } catch (e) {
        this.deps.log.warn('eval.cleanup_failed', { missionId, targetId: record.id, error: errorMessage(e) });
      }
    }
    for (const branch of branches) {
      if (repository === undefined || this.deps.exec === null) {
        this.deps.log.warn('eval.cleanup_failed', { missionId, branch, error: 'No git to delete the branch with.' });
        continue;
      }
      try {
        const result = await this.deps.exec.run({
          command: 'git', args: ['branch', '-D', branch], cwd: repository.path, timeoutMs: GIT_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' },
        });
        // Already gone is what cleaning up wanted anyway.
        if (result.exitCode !== 0 && !/not found/i.test(`${result.stderr}${result.stdout}`)) {
          this.deps.log.warn('eval.cleanup_failed', { missionId, branch, error: result.stderr.trim() });
        }
      } catch (e) {
        this.deps.log.warn('eval.cleanup_failed', { missionId, branch, error: errorMessage(e) });
      }
    }
  }

  /** `#cleanUp` for a path that is already handling a failure: nothing it throws may hide that failure. */
  async #cleanUpQuietly(missionId: MissionId): Promise<void> {
    try {
      await this.#cleanUp(missionId);
    } catch (e) {
      this.deps.log.warn('eval.cleanup_failed', { missionId, error: errorMessage(e) });
    }
  }

  /**
   * A worktree target left without a branch: the worktree the factory would have made for it,
   * if git has one registered - `tandemise/<mission slug>/<target name slug>-<task id tail>` - or null.
   */
  async #provisionedWorktree(record: ExecutionTargetRecord, mission: Mission, repositoryPath: string): Promise<ExecutionTargetRecord | null> {
    if (this.deps.exec === null || record.taskId === null) return null;
    const branch = `tandemise/${slugify(mission.title)}/${slugify(record.name)}-${record.taskId.slice(-8)}`;
    try {
      const listed = await this.deps.exec.run({
        command: 'git', args: ['worktree', 'list', '--porcelain'], cwd: repositoryPath, timeoutMs: GIT_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' },
      });
      if (listed.exitCode !== 0) return null;
      for (const entry of listed.stdout.split(/\n\s*\n/)) {
        const path = /^worktree (.+)$/m.exec(entry)?.[1];
        if (path !== undefined && entry.includes(`branch refs/heads/${branch}`)) return { ...record, workingDirectory: path, branch };
      }
      // No worktree, but `worktree add -b` may still have created the branch before it failed.
      return { ...record, branch, status: 'RELEASED' };
    } catch (e) {
      this.deps.log.warn('eval.cleanup_failed', { missionId: mission.id, targetId: record.id, error: errorMessage(e) });
      return null;
    }
  }

  #endTrial(id: EvalTrialId, status: EvalTrialStatus, reason: string | null, score: EvalTrial['score']): void {
    this.deps.evals.updateTrial(id, { status, reason, score, finishedAt: this.deps.clock.now() });
  }

  #cancelQueued(runId: EvalRunId, reason: string): void {
    for (const trial of this.deps.evals.listTrials(runId)) {
      if (trial.status === 'queued') this.#endTrial(trial.id, 'cancelled', reason, null);
    }
  }

  #finishRun(run: EvalRun, status: EvalRunStatus, reason: string | null): void {
    this.deps.evals.updateRun(run.id, {
      status, reason, scorecard: scorecardFor(this.deps.evals, run), finishedAt: this.deps.clock.now(),
    });
    this.deps.log.info('eval.run_finished', { runId: run.id, status });
  }
}

/** A trial's status, reason and mission status from how its step ended. */
function trialOutcome(end: Exclude<TrialEnd, { kind: 'stopping' }>): [EvalTrialStatus, string | null, MissionStatus] {
  if (end.kind === 'cancelled') return ['cancelled', 'Cancelled before the trial finished.', 'CANCELLED'];
  if (end.status === 'SUCCEEDED') return ['passed', null, 'COMPLETE'];
  if (end.status === 'CANCELLED') return ['cancelled', end.reason, 'CANCELLED'];
  if (end.status === 'BLOCKED') return ['blocked', end.reason, 'FAILED'];
  return ['failed', end.reason ?? `The step ended ${end.status.toLowerCase()}.`, 'FAILED'];
}

function nonBlank(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value.trim() === '' ? undefined : value;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
