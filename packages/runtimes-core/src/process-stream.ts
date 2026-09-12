import { TandemiseError, errorMessage } from '@tandemise/shared';
import type { Logger } from '@tandemise/shared';
import type { NormalizingEventSink } from './event-sink.js';
import { LineAssembler } from './line-assembler.js';
import { classifyAbort, escalateTerminationOnAbort, withWallTimeBudget } from './termination.js';
import type { Terminable } from './termination.js';

/**
 * Process supervision for every CLI-backed runtime (MVP.md §21.1).
 *
 * The child is described *structurally* and spawned by a thunk the adapter
 * supplies, so this file names no provider module and the core stays free of
 * `node:child_process` (MVP.md §6.1). The adapter contributes the one line that
 * knows about Node; everything that is actually a Tandemise decision - back
 * pressure, cancellation escalation, what an exit means when the runtime
 * already gave a verdict - lives here exactly once.
 *
 * It exists because three adapters had begun to grow their own copy of it, and
 * the third copy is where the subtle divergence starts: the duplicate-terminal
 * -event bug was a guard that one copy had and another did not.
 */

/** Queue depth at which the child's stdout is paused, and where it resumes. */
export const BACKPRESSURE_HIGH_WATER = 256;
export const BACKPRESSURE_LOW_WATER = 64;

export interface ProcessOutputStream {
  setEncoding(encoding: 'utf8'): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  pause(): unknown;
  resume(): unknown;
  isPaused(): boolean;
}

export interface ProcessInputStream {
  end(chunk: string): unknown;
}

/** The part of a spawned child this module needs. `ChildProcess` satisfies it. */
export interface SupervisedChild extends Terminable {
  /** Optional, not `number | undefined`: `ChildProcess` declares it optional. */
  readonly pid?: number | undefined;
  readonly stdout: ProcessOutputStream | null;
  readonly stderr: ProcessOutputStream | null;
  readonly stdin: ProcessInputStream | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'close', listener: () => void): unknown;
}

export interface ProcessStreamOptions {
  /**
   * Spawns the child. A thunk rather than a command plus options, because the
   * stdio shape depends on whether this run delivers its prompt on stdin - a
   * decision only the adapter can make.
   */
  readonly spawn: () => SupervisedChild;
  /** Written to the child's stdin and closed, when the prompt goes that way. */
  readonly stdin: string | null;
  readonly signal: AbortSignal;
  readonly maxWallTimeMs: number;
  readonly graceMs: number;
  readonly sink: NormalizingEventSink;
  readonly log: Logger;
  /** Human-readable command, used only in failure messages. */
  readonly describe: string;
  /** Called for each complete stdout line. Must not throw. */
  readonly onStdoutLine: (line: string) => void;
  /**
   * The runtime's verdict, when it gave none of its own. Not called if a
   * terminal event was already emitted, or if the run was cancelled.
   */
  readonly onExit: (exitCode: number | null, killedBy: NodeJS.Signals | null) => void;
}

export interface SupervisedStream {
  readonly child: SupervisedChild;
  /** Detaches the abort listener and force-kills a child still running. */
  dispose(): void;
}

export function superviseProcessStream(options: ProcessStreamOptions): SupervisedStream {
  const { sink, log } = options;
  const signal = withWallTimeBudget(options.signal, options.maxWallTimeMs);

  const child = options.spawn();
  const unsubscribe = escalateTerminationOnAbort(child, signal, options.graceMs, () => {
    log.warn('child ignored SIGTERM; sent SIGKILL', { pid: child.pid, command: options.describe });
  });

  const { stdout, stderr } = child;
  if (stdout === null || stderr === null) {
    sink.abort(new TandemiseError('INTERNAL', `${options.describe} was spawned without piped stdio`));
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
    sink.abort(new TandemiseError('RUNTIME_FAILED', `Failed to run ${options.describe}: ${errorMessage(e)}`, { cause: e }));
  });

  child.on('close', (code, killedBy) => {
    // A runtime that already reported its own verdict has said everything there
    // is to say; the exit is then merely how the process happened to stop.
    // Emitting a second terminal event here would end the run twice.
    if (!sink.terminated) {
      if (signal.aborted) {
        const outcome = classifyAbort(options.signal, options.maxWallTimeMs);
        sink.fail(outcome.code, outcome.message, outcome.retryable);
      } else {
        options.onExit(code, killedBy);
      }
    }
    sink.close();
  });

  if (options.stdin !== null && child.stdin !== null) child.stdin.end(options.stdin);

  return {
    child,
    dispose: () => {
      unsubscribe();
      // A consumer that stopped iterating early - a `break`, or a failure
      // downstream - must not leave an agent running against the workspace.
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        const force = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, options.graceMs);
        force.unref();
      }
    },
  };
}

/** Lets a paused stdout resume once the consumer has caught up. */
export function relieveBackPressure(child: SupervisedChild, pending: number): void {
  const { stdout } = child;
  if (stdout !== null && stdout.isPaused() && pending <= BACKPRESSURE_LOW_WATER) stdout.resume();
}
