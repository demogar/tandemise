import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  TandemiseError,
  errorMessage,
  systemClock,
  type Clock,
  type Logger,
  type Timestamp,
} from '@tandemise/shared';
import {
  buildProcessEnv,
  formatCommand,
  type ExecResult,
  type LiveProcess,
  type OutputStream,
  type ProcessCorrelation,
  type ProcessExit,
  type ProcessSpec,
  type ProcessSupervisor,
  type SupervisedProcess,
} from '@tandemise/execution-core';
import { LineQueue, LineSplitter } from './line-stream.js';

const DEFAULT_KILL_GRACE_MS = 5_000;

export interface SupervisorOptions {
  readonly killGraceMs?: number;
  readonly clock?: Clock;
}

/**
 * The Node implementation of MVP.md §21.1.
 *
 * Every child is started in its own process group (`detached`). That single
 * decision is what makes cancellation actually work: an agent CLI that shells
 * out to a dev server leaves grandchildren behind, and signalling the group
 * reaches them where signalling the pid does not.
 */
export class NodeProcessSupervisor implements ProcessSupervisor {
  readonly #live = new Map<string, NodeSupervisedProcess>();
  readonly #killGraceMs: number;
  readonly #clock: Clock;

  constructor(
    private readonly log: Logger,
    options: SupervisorOptions = {},
  ) {
    this.#killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.#clock = options.clock ?? systemClock;
  }

  spawn(spec: ProcessSpec): SupervisedProcess {
    return this.#start(spec);
  }

  #start(spec: ProcessSpec): NodeSupervisedProcess {
    const proc = new NodeSupervisedProcess(spec, {
      clock: this.#clock,
      log: this.log,
      killGraceMs: spec.killGraceMs ?? this.#killGraceMs,
    });
    this.#live.set(proc.id, proc);
    void proc.wait().finally(() => this.#live.delete(proc.id));
    return proc;
  }

  async run(
    spec: ProcessSpec,
    onOutput?: (chunk: string, stream: OutputStream) => void,
  ): Promise<ExecResult> {
    const proc = this.#start(spec);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const collect = (target: string[], stream: OutputStream) => async (): Promise<void> => {
      const source = stream === 'stdout' ? proc.stdout() : proc.stderr();
      for await (const line of source) {
        target.push(line);
        onOutput?.(line + '\n', stream);
      }
    };
    const [, , exit] = await Promise.all([
      collect(stdout, 'stdout')(),
      collect(stderr, 'stderr')(),
      proc.wait(),
    ]);
    if (exit.killedReason === 'spawn-failed') {
      throw new TandemiseError('INTERNAL', `Failed to start '${spec.command}': ${stderr.join(' ')}`, {
        details: { command: spec.command, cwd: spec.cwd },
      });
    }
    return {
      exitCode: exit.exitCode,
      stdout: joinLines(stdout, proc.endedWithNewline('stdout')),
      stderr: joinLines(stderr, proc.endedWithNewline('stderr')),
      timedOut: exit.timedOut,
      durationMs: exit.durationMs,
      command: formatCommand(spec.command, spec.args),
    };
  }

  liveProcesses(): readonly LiveProcess[] {
    return [...this.#live.values()].map((p) => ({
      id: p.id,
      pid: p.pid,
      label: p.label,
      cwd: p.cwd,
      startedAt: p.startedAt,
      correlation: p.correlation,
    }));
  }

  async killAll(reason: string): Promise<void> {
    const live = [...this.#live.values()];
    if (live.length === 0) return;
    this.log.info('supervisor.kill_all', { count: live.length, reason });
    await Promise.all(live.map((p) => p.kill(reason).catch(() => undefined)));
    this.#live.clear();
  }
}

interface ProcessDeps {
  readonly clock: Clock;
  readonly log: Logger;
  readonly killGraceMs: number;
}

class NodeSupervisedProcess implements SupervisedProcess {
  readonly id = randomUUID();
  readonly label: string;
  readonly cwd: string;
  readonly startedAt: Timestamp;
  readonly correlation: ProcessCorrelation;
  readonly pid: number;

  readonly #child: ChildProcessWithoutNullStreams;
  readonly #stdout = new LineQueue();
  readonly #stderr = new LineQueue();
  readonly #exit: Promise<ProcessExit>;
  readonly #deps: ProcessDeps;
  readonly #startedMs: number;

  #bytesOut = 0;
  #bytesErr = 0;
  readonly #trailingPartial: Record<OutputStream, boolean> = { stdout: false, stderr: false };
  #lastOutputAt: number | null = null;
  #killedReason: string | null = null;
  #timedOut = false;

  constructor(spec: ProcessSpec, deps: ProcessDeps) {
    this.#deps = deps;
    this.label = spec.label ?? formatCommand(spec.command, spec.args);
    this.cwd = spec.cwd;
    this.correlation = spec.correlation ?? {};
    this.startedAt = deps.clock.now();
    this.#startedMs = deps.clock.epochMs();

    this.#child = startChild(spec);
    this.pid = this.#child.pid ?? -1;

    const log = deps.log.child({ processId: this.id, pid: this.pid, ...this.correlation });
    log.debug('process.spawned', { label: this.label, cwd: this.cwd });

    this.#pump(this.#child.stdout, this.#stdout, 'stdout');
    this.#pump(this.#child.stderr, this.#stderr, 'stderr');
    this.#writeStdin(spec.stdin);

    this.#exit = this.#awaitExit(log);
    this.#armTimeout(spec);
    this.#armAbort(spec);
    this.#armHeartbeat(spec);
  }

  stdout(): AsyncIterable<string> {
    return this.#stdout;
  }

  stderr(): AsyncIterable<string> {
    return this.#stderr;
  }

  wait(): Promise<ProcessExit> {
    return this.#exit;
  }

  /**
   * False when the stream's last line had no terminator. Line-oriented output
   * is reassembled from lines, and git's `-z` output has no newlines at all -
   * appending one would invent a NUL-separated field that was never there.
   */
  endedWithNewline(stream: OutputStream): boolean {
    return !this.#trailingPartial[stream];
  }

  /**
   * Cancellation escalation (MVP.md §21.1): closing stdin is the graceful
   * request - most CLIs treat EOF as "finish what you have" - then SIGTERM,
   * then SIGKILL once the grace period expires.
   */
  async kill(reason: string, options: { graceMs?: number } = {}): Promise<ProcessExit> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return this.#exit;
    this.#killedReason ??= reason;
    this.#deps.log.info('process.kill', { processId: this.id, pid: this.pid, reason, label: this.label });

    this.#child.stdin.end();
    this.#signal('SIGTERM');

    const graceMs = options.graceMs ?? this.#deps.killGraceMs;
    const escalation = setTimeout(() => {
      this.#deps.log.warn('process.sigkill', { processId: this.id, pid: this.pid, reason, graceMs });
      this.#signal('SIGKILL');
    }, graceMs);
    escalation.unref();
    try {
      return await this.#exit;
    } finally {
      clearTimeout(escalation);
    }
  }

  /** Signals the whole process group, falling back to the pid alone. */
  #signal(signal: NodeJS.Signals): void {
    if (this.pid <= 0) return;
    try {
      process.kill(-this.pid, signal);
    } catch {
      try {
        this.#child.kill(signal);
      } catch {
        /* already reaped */
      }
    }
  }

  #pump(stream: NodeJS.ReadableStream, queue: LineQueue, which: OutputStream): void {
    const splitter = new LineSplitter();
    stream.on('data', (chunk: Buffer) => {
      if (which === 'stdout') this.#bytesOut += chunk.length;
      else this.#bytesErr += chunk.length;
      this.#lastOutputAt = this.#deps.clock.epochMs();
      splitter.push(chunk, (line) => queue.push(line));
    });
    const finish = (): void => {
      this.#trailingPartial[which] ||= splitter.end((line) => queue.push(line));
      queue.close();
    };
    stream.on('end', finish);
    stream.on('error', finish);
  }

  #writeStdin(stdin: string | undefined): void {
    // A child that is never given EOF can block forever waiting for input.
    this.#child.stdin.on('error', () => undefined);
    if (stdin !== undefined) this.#child.stdin.write(stdin);
    this.#child.stdin.end();
  }

  #awaitExit(log: Logger): Promise<ProcessExit> {
    return new Promise<ProcessExit>((resolve) => {
      const settle = (exitCode: number, signal: NodeJS.Signals | null): void => {
        const exit: ProcessExit = {
          exitCode,
          signal,
          timedOut: this.#timedOut,
          killedReason: this.#killedReason,
          durationMs: this.#deps.clock.epochMs() - this.#startedMs,
        };
        log.debug('process.exited', {
          label: this.label,
          exitCode,
          signal: signal ?? undefined,
          ms: exit.durationMs,
        });
        resolve(exit);
      };
      this.#child.on('error', (err) => {
        // ENOENT and friends: no exit event will follow, so settle here.
        this.#killedReason = 'spawn-failed';
        this.#stderr.push(errorMessage(err));
        this.#stdout.close();
        this.#stderr.close();
        settle(-1, null);
      });
      this.#child.on('close', (code, signal) => settle(code ?? (signal ? 137 : -1), signal));
    });
  }

  #armTimeout(spec: ProcessSpec): void {
    if (!spec.timeoutMs) return;
    const timer = setTimeout(() => {
      this.#timedOut = true;
      void this.kill(`timeout after ${spec.timeoutMs}ms`);
    }, spec.timeoutMs);
    timer.unref();
    void this.#exit.finally(() => clearTimeout(timer));
  }

  #armAbort(spec: ProcessSpec): void {
    const signal = spec.signal;
    if (!signal) return;
    if (signal.aborted) {
      void this.kill('aborted');
      return;
    }
    const onAbort = (): void => void this.kill('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    void this.#exit.finally(() => signal.removeEventListener('abort', onAbort));
  }

  #armHeartbeat(spec: ProcessSpec): void {
    const every = spec.heartbeatMs;
    const onHeartbeat = spec.onHeartbeat;
    if (!every || !onHeartbeat) return;
    const timer = setInterval(() => {
      onHeartbeat({
        id: this.id,
        pid: this.pid,
        label: this.label,
        uptimeMs: this.#deps.clock.epochMs() - this.#startedMs,
        bytesOut: this.#bytesOut,
        bytesErr: this.#bytesErr,
        lastOutputAt: this.#lastOutputAt,
      });
    }, every);
    timer.unref();
    void this.#exit.finally(() => clearInterval(timer));
  }
}

/**
 * `spawn` reports most failures asynchronously via an `error` event, but a few
 * (E2BIG, EINVAL) throw synchronously. Normalising both keeps callers from
 * having to handle a raw errno exception alongside a TandemiseError.
 */
function startChild(spec: ProcessSpec): ChildProcessWithoutNullStreams {
  try {
    return nodeSpawn(spec.command, [...(spec.args ?? [])], {
      cwd: spec.cwd,
      env: buildProcessEnv(spec),
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group, so cancellation can reach the whole tree.
      detached: true,
    }) as ChildProcessWithoutNullStreams;
  } catch (cause) {
    throw new TandemiseError('INTERNAL', `Cannot spawn '${spec.command}': ${errorMessage(cause)}`, {
      details: { command: spec.command, cwd: spec.cwd, argCount: spec.args?.length ?? 0 },
      cause,
    });
  }
}

function joinLines(lines: readonly string[], trailingNewline: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (trailingNewline ? '\n' : '');
}
