import type { MissionTask, Repository, WaitPolicy } from '@tandemise/domain';
import type { CommandExecutor } from '@tandemise/integrations-core';
import type { Clock, Logger } from '@tandemise/shared';
import { errorMessage } from '@tandemise/shared';

/**
 * Watches something outside this machine until it is done.
 *
 * An end-to-end process does not stop at "push the code": it waits for CI, then
 * merges, waits for the deploy, then checks the deployed thing. Every one of
 * those waits on a system Tandemise does not control.
 *
 * The obvious way to do this is an agent that polls in a loop, and it is the
 * wrong way. An agent re-sends its whole context on every turn, so a ten-minute
 * CI wait is billed as a ten-minute conversation - a cost the beveloce tooling
 * measured at 249k tokens re-sent per turn and wrote a rule against. A wait step
 * holds no model at all: it runs one command on an interval and looks at the
 * exit code.
 *
 * It also holds no worker slot. A mission waiting twenty minutes on a deploy
 * should not be occupying one of three concurrency slots while agent work that
 * could proceed sits behind it.
 */
export interface WaitOutcome {
  readonly kind: 'passed' | 'timedOut' | 'cancelled';
  readonly detail: string;
  readonly polls: number;
}

export interface WaiterDeps {
  readonly exec: () => CommandExecutor;
  readonly clock: Clock;
  readonly log: Logger;
}

export class Waiter {
  constructor(private readonly deps: WaiterDeps) {}

  async wait(
    task: MissionTask,
    policy: WaitPolicy,
    repository: Repository | null,
    signal: AbortSignal,
  ): Promise<WaitOutcome> {
    const log = this.deps.log.child({ taskId: task.id, component: 'waiter' });
    const deadline = this.deps.clock.epochMs() + policy.timeoutMs;
    let polls = 0;

    while (!signal.aborted) {
      polls += 1;
      const remaining = deadline - this.deps.clock.epochMs();
      if (remaining <= 0) break;

      let result;
      try {
        result = await this.deps.exec().run({
          command: policy.command,
          ...(repository === null ? {} : { cwd: repository.path }),
          // Never longer than what is left: a command that hangs must not
          // outlive the wait it belongs to.
          timeoutMs: Math.min(policy.everyMs * 2, remaining),
          signal,
        });
      } catch (error) {
        // A poll that could not run at all is not a failed condition - the
        // deploy may be fine and the network may not be. Keep waiting; the
        // timeout is what ends this.
        log.warn('wait.poll_failed', { error: errorMessage(error) });
        if (!(await this.#sleep(Math.min(policy.everyMs, deadline - this.deps.clock.epochMs()), signal))) break;
        continue;
      }

      if (result.exitCode === 0) {
        return {
          kind: 'passed',
          detail: firstLine(result.stdout) || `\`${policy.command}\` succeeded.`,
          polls,
        };
      }

      log.debug('wait.still_waiting', { polls, exitCode: result.exitCode });
      if (!(await this.#sleep(Math.min(policy.everyMs, deadline - this.deps.clock.epochMs()), signal))) break;
    }

    if (signal.aborted) {
      return { kind: 'cancelled', detail: 'The mission was stopped while waiting.', polls };
    }
    return {
      kind: 'timedOut',
      detail: `\`${policy.command}\` did not succeed within ${Math.round(policy.timeoutMs / 60_000)} minutes.`,
      polls,
    };
  }

  /** Resolves false when the wait was cancelled rather than slept through. */
  async #sleep(ms: number, signal: AbortSignal): Promise<boolean> {
    if (ms <= 0 || signal.aborted) return false;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve(false);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 300) ?? '';
}
