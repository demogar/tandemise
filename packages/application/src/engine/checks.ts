import type {
  CheckResult, EvaluationRepositoryPort, MissionTask, Repository,
} from '@tandemise/domain';
import { gateDependencies } from '@tandemise/domain';
import { checkSpecsFor, createCommandCheckRunner, type CheckSpec } from '@tandemise/evaluation';
import type { ExecutionTarget } from '@tandemise/execution-core';
import type { Clock, RunId } from '@tandemise/shared';
import { errorMessage, newId, summarize } from '@tandemise/shared';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';

const CHECK_PREFIX = 'checks.';
const INSTALL_CHECK = 'checks.install';
/** Measured here with the checks, and stored as one, so "newest wins" applies to it too (P15). */
export const GIT_CLEAN_FACT = 'git.clean';
/** How many dirty paths the detail lists before "and N more". */
const DIRTY_LISTED = 20;

export interface CheckRequest {
  readonly task: MissionTask;
  readonly repository: Repository | null;
  readonly target: ExecutionTarget;
  readonly runId: RunId | null;
  readonly scope: EventScope;
  readonly signal: AbortSignal;
}

/**
 * Runs a repository's configured checks inside the target the task ran in
 * (MVP.md §17.1).
 *
 * Two decisions worth stating.
 *
 * **Only the checks a gate reads are run.** A gate is the only consumer of a
 * check result, so running a build for a task whose gate never mentions it
 * spends the user's wall-clock time to produce a fact nobody reads. The one
 * exception is `install`: a typecheck in a fresh worktree fails for want of
 * dependencies rather than for want of correctness, which would be a lie told
 * by a gate.
 *
 * **The commands run in the target, not on the host.** A worktree task's checks
 * must see the worktree's tree, and a future container target must run them
 * inside the container. Routing them through `ExecutionTarget.exec` is what
 * makes that true by construction rather than by convention.
 */
export class CheckService {
  constructor(
    private readonly evaluations: EvaluationRepositoryPort,
    private readonly recorder: EventRecorder,
    private readonly clock: Clock,
  ) {}

  async run(request: CheckRequest): Promise<readonly CheckResult[]> {
    const { task, repository, target } = request;
    if (repository === null) return [];

    const specs = this.#specsFor(task, repository);
    const wantsClean = gateDependencies(task.completionGate ?? '').includes(GIT_CLEAN_FACT);
    if (specs.length === 0 && !wantsClean) return [];

    const runner = createCommandCheckRunner({
      execute: async (command, options) => {
        try {
          const result = await target.exec({
            // A configured check is a shell line ("npm test && npm run lint"),
            // so it needs a shell. It comes from the repository's own
            // configuration, never from an agent.
            command: '/bin/sh',
            args: ['-lc', command],
            cwd: options.cwd,
            timeoutMs: options.timeoutMs,
            signal: request.signal,
          });
          return {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
          };
        } catch (e) {
          // A target that cannot run the command at all is a failed check with
          // an explanation, not an exception that loses every other result.
          return { exitCode: 1, stdout: '', stderr: errorMessage(e), durationMs: 0 };
        }
      },
      clock: this.clock,
    });

    const measured = await runner.runAll(specs, {
      missionId: task.missionId,
      taskId: task.id,
      runId: request.runId,
      cwd: target.workingDirectory,
    });
    // Last, so it sees what the checks themselves left behind: a build that
    // rewrites a tracked file is exactly what `git.clean` exists to catch.
    const results = wantsClean ? [...measured, await this.#gitClean(request)] : measured;

    for (const result of results) {
      this.evaluations.recordCheck(result);
      this.recorder.record(request.scope, {
        type: 'check.result',
        name: result.name,
        outcome: result.outcome,
        detail: result.detail,
      });
    }
    this.recorder.invalidate('checks', task.missionId);
    return results;
  }

  /**
   * `git.clean`: nothing uncommitted in the step's worktree after the executor
   * committed the worker's changes and the checks ran.
   *
   * Only a worktree can be measured: a step working in place shares your
   * checkout, whose state says nothing about the step. The validator refuses
   * the fact on such a step; one that gets here anyway reads SKIP, which never
   * passes.
   */
  async #gitClean(request: CheckRequest): Promise<CheckResult> {
    const { task, target } = request;
    const started = this.clock.epochMs();
    const base = {
      id: newId<'CheckResultId'>('chk'),
      missionId: task.missionId,
      taskId: task.id,
      runId: request.runId,
      name: GIT_CLEAN_FACT,
      command: 'git status --porcelain',
      outputRef: null,
    };
    if (target.kind !== 'worktree') {
      return {
        ...base, outcome: 'SKIP', exitCode: null, durationMs: 0, createdAt: this.clock.now(),
        detail: 'Only measured on a step that works in its own worktree; this step works in place.',
      };
    }
    try {
      const status = await target.exec({
        command: 'git', args: ['status', '--porcelain', '--untracked-files=all'], signal: request.signal,
      });
      const durationMs = this.clock.epochMs() - started;
      if (status.exitCode !== 0) {
        return {
          ...base, outcome: 'FAIL', exitCode: status.exitCode, durationMs, createdAt: this.clock.now(),
          detail: `\`git status\` exited ${status.exitCode}: ${summarize(status.stderr.trim(), 400)}`,
        };
      }
      const dirty = status.stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0);
      if (dirty.length === 0) {
        return { ...base, outcome: 'PASS', exitCode: 0, durationMs, createdAt: this.clock.now(), detail: 'Nothing uncommitted in the worktree.' };
      }
      const listed = dirty.slice(0, DIRTY_LISTED).join('\n');
      const more = dirty.length > DIRTY_LISTED ? `\nand ${dirty.length - DIRTY_LISTED} more` : '';
      return {
        ...base, outcome: 'FAIL', exitCode: 0, durationMs, createdAt: this.clock.now(),
        detail: `${dirty.length} ${dirty.length === 1 ? 'path is' : 'paths are'} not committed:\n${listed}${more}`,
      };
    } catch (e) {
      return {
        ...base, outcome: 'FAIL', exitCode: null, durationMs: this.clock.epochMs() - started, createdAt: this.clock.now(),
        detail: `Could not run \`git status\`: ${errorMessage(e)}`,
      };
    }
  }

  #specsFor(task: MissionTask, repository: Repository): readonly CheckSpec[] {
    const wanted = new Set(
      gateDependencies(task.completionGate ?? '').filter((f) => f.startsWith(CHECK_PREFIX)),
    );
    if (wanted.size === 0) return [];

    // Dependencies first, and only when something else is going to need them.
    if (repository.checks.install !== null) wanted.add(INSTALL_CHECK);

    const specs = checkSpecsFor(repository.checks, [...wanted]);
    const install = specs.filter((s) => s.name === INSTALL_CHECK);
    return [...install, ...specs.filter((s) => s.name !== INSTALL_CHECK)];
  }
}
