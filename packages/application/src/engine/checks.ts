import type {
  CheckResult, EvaluationRepositoryPort, MissionTask, Repository,
} from '@tandemise/domain';
import { gateDependencies } from '@tandemise/domain';
import { checkSpecsFor, createCommandCheckRunner, type CheckSpec } from '@tandemise/evaluation';
import type { ExecutionTarget } from '@tandemise/execution-core';
import type { Clock, RunId } from '@tandemise/shared';
import { errorMessage } from '@tandemise/shared';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';

const CHECK_PREFIX = 'checks.';
const INSTALL_CHECK = 'checks.install';

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
    if (specs.length === 0) return [];

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

    const results = await runner.runAll(specs, {
      missionId: task.missionId,
      taskId: task.id,
      runId: request.runId,
      cwd: target.workingDirectory,
    });

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
