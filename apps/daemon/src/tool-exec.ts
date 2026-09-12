import type {
  BackgroundProcess, BackgroundProcessLauncher, BackgroundProcessSpec,
  CommandExecutor, ToolExecRequest, ToolExecResult,
} from '@tandemise/integrations-core';
import type { ProcessSupervisor } from '@tandemise/execution-core';
import { errorMessage, type Logger } from '@tandemise/shared';

/**
 * How an integration tool runs a command.
 *
 * `integrations-core` deliberately cannot import `node:child_process` - it is a
 * core package, and the boundary check enforces it - so it declares this port
 * and the composition root supplies an implementation. Routing it through the
 * `ProcessSupervisor` rather than spawning directly is what gives every tool
 * invocation the same properties a worker run gets: an allowlisted environment,
 * a tracked process, cancellation escalation, and no orphan on shutdown.
 */
export function createToolCommandExecutor(
  supervisor: ProcessSupervisor,
  log: Logger,
): CommandExecutor {
  return {
    async run(request: ToolExecRequest): Promise<ToolExecResult> {
      const started = Date.now();
      const commandLine = [request.command, ...(request.args ?? [])].join(' ');
      let timedOut = false;

      const child = supervisor.spawn({
        command: request.command,
        args: request.args ?? [],
        cwd: request.cwd ?? process.cwd(),
        env: request.env ?? {},
        label: `tool:${request.command}`,
        stdin: request.stdin,
      });

      const stopOnAbort = (): void => { void child.kill('tool call was cancelled'); };
      request.signal?.addEventListener('abort', stopOnAbort, { once: true });

      const budget = request.timeoutMs === undefined ? undefined : setTimeout(() => {
        timedOut = true;
        void child.kill(`tool call exceeded ${request.timeoutMs}ms`);
      }, request.timeoutMs);
      budget?.unref();

      const stdout: string[] = [];
      const stderr: string[] = [];
      try {
        // Both streams are drained concurrently. Reading one to completion
        // before the other deadlocks as soon as the unread pipe fills, which a
        // chatty CLI reaches within a few hundred kilobytes.
        await Promise.all([
          (async () => { for await (const line of child.stdout()) stdout.push(line); })(),
          (async () => { for await (const line of child.stderr()) stderr.push(line); })(),
        ]);
        const exit = await child.wait();
        return {
          exitCode: exit.exitCode,
          stdout: stdout.join('\n'),
          stderr: stderr.join('\n'),
          timedOut: timedOut || exit.timedOut,
          durationMs: Date.now() - started,
          command: commandLine,
        };
      } catch (e) {
        // A spawn that never started is an ordinary tool failure - a missing
        // `gh`, a path that is not executable - not an internal error.
        log.debug('tool_exec.failed', { command: request.command, error: errorMessage(e) });
        return {
          exitCode: 127,
          stdout: stdout.join('\n'),
          stderr: stderr.join('\n') || errorMessage(e),
          timedOut,
          durationMs: Date.now() - started,
          command: commandLine,
        };
      } finally {
        if (budget !== undefined) clearTimeout(budget);
        request.signal?.removeEventListener('abort', stopOnAbort);
      }
    },
  };
}

/**
 * Long-lived processes a tool starts and does not wait for - a dev server that
 * QA drives, a tunnel. Supervised like everything else, so `killAll()` on
 * shutdown reaps them.
 */
export function createBackgroundProcessLauncher(
  supervisor: ProcessSupervisor,
): BackgroundProcessLauncher {
  return {
    launch(spec: BackgroundProcessSpec): BackgroundProcess {
      const child = supervisor.spawn({
        command: spec.command,
        args: spec.args ?? [],
        cwd: spec.cwd,
        env: spec.env ?? {},
        label: `background:${spec.command}`,
      });

      if (spec.onOutput) {
        void (async () => { for await (const line of child.stdout()) spec.onOutput!(line, 'stdout'); })();
        void (async () => { for await (const line of child.stderr()) spec.onOutput!(line, 'stderr'); })();
      }

      return {
        pid: child.pid,
        exited: child.wait().then((exit) => ({ exitCode: exit.exitCode, signal: exit.signal })),
        stop: async () => { await child.kill('background process stopped'); },
      };
    },
  };
}
