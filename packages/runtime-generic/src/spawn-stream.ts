import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  LineAssembler, classifyAbort, escalateTerminationOnAbort, withWallTimeBudget,
} from '@tandemise/runtimes-core';
import type { NormalizingEventSink } from '@tandemise/runtimes-core';
import { TandemiseError, errorMessage } from '@tandemise/shared';
import type { Logger } from '@tandemise/shared';

/** Queue depth at which the child's stdout is paused, and where it resumes. */
export const BACKPRESSURE_HIGH_WATER = 256;
export const BACKPRESSURE_LOW_WATER = 64;

export interface SpawnStreamOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string | null;
  readonly signal: AbortSignal;
  readonly maxWallTimeMs: number;
  readonly graceMs: number;
  readonly sink: NormalizingEventSink;
  readonly log: Logger;
  /** Called for each complete stdout line. Must not throw. */
  readonly onStdoutLine: (line: string) => void;
  /** Last chance to push a terminal event before the sink closes. */
  readonly onClose: (exitCode: number | null, killedBy: NodeJS.Signals | null, aborted: boolean) => void;
  readonly onSpawned?: (child: ChildProcess) => void;
}

export interface SpawnedStream {
  readonly child: ChildProcess;
  /** Detaches the abort listener and force-kills a child still running. */
  dispose(): void;
}

/**
 * Spawns a child, feeds its stdout lines to `onStdoutLine`, mirrors stderr into
 * the sink as `raw` events, and closes the sink when the process ends.
 *
 * The pausing/resuming is not incidental: an agent that produces events faster
 * than the consumer persists them would otherwise grow an unbounded queue for
 * the whole run. Pausing the pipe pushes that back onto the child, which is
 * where the cost belongs.
 */
export function spawnStream(options: SpawnStreamOptions): SpawnedStream {
  const { sink, log } = options;
  const signal = withWallTimeBudget(options.signal, options.maxWallTimeMs);

  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    // Inherited on purpose: a configured CLI authenticates through the user's
    // own environment, exactly as Claude Code does (MVP.md §10.3).
    env: process.env,
    stdio: [options.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  options.onSpawned?.(child);

  const unsubscribe = escalateTerminationOnAbort(child, signal, options.graceMs, () => {
    log.warn('child ignored SIGTERM; sent SIGKILL', { pid: child.pid });
  });

  const { stdout, stderr } = child;
  if (stdout === null || stderr === null) {
    sink.abort(new TandemiseError('INTERNAL', 'Child was spawned without piped stdio'));
    return { child, dispose: unsubscribe };
  }

  const stdoutLines = new LineAssembler();
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    try {
      for (const line of stdoutLines.push(chunk)) options.onStdoutLine(line);
    } catch (e) {
      sink.abort(e);
      return;
    }
    if (sink.pending >= BACKPRESSURE_HIGH_WATER) stdout.pause();
  });
  stdout.on('end', () => {
    const trailing = stdoutLines.flush();
    if (trailing !== null) options.onStdoutLine(trailing);
  });

  const stderrLines = new LineAssembler();
  stderr.setEncoding('utf8');
  stderr.on('data', (chunk: string) => {
    for (const line of stderrLines.push(chunk)) sink.raw('stderr', line);
  });
  stderr.on('end', () => {
    const trailing = stderrLines.flush();
    if (trailing !== null) sink.raw('stderr', trailing);
  });

  child.on('error', (e) => {
    sink.abort(new TandemiseError('RUNTIME_FAILED', `Failed to run ${options.command}: ${errorMessage(e)}`, { cause: e }));
  });

  child.on('close', (code, killedBy) => {
    if (signal.aborted && !sink.terminated) {
      const outcome = classifyAbort(options.signal, options.maxWallTimeMs);
      sink.fail(outcome.code, outcome.message, outcome.retryable);
    } else {
      options.onClose(code, killedBy, signal.aborted);
    }
    sink.close();
  });

  if (options.stdin !== null && child.stdin !== null) child.stdin.end(options.stdin);

  return {
    child,
    dispose: () => {
      unsubscribe();
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        const forceTimer = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, options.graceMs);
        forceTimer.unref();
      }
    },
  };
}

/** Lets a paused stdout resume once the consumer has caught up. */
export function relieveBackPressure(child: ChildProcess, pending: number): void {
  if (child.stdout?.isPaused() === true && pending <= BACKPRESSURE_LOW_WATER) child.stdout.resume();
}
