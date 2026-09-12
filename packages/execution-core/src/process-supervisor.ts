import type { Timestamp } from '@tandemise/shared';
import type { ExecResult, OutputStream } from './exec.js';

/**
 * Correlation fields carried into every log line the supervisor emits about a
 * process, so a stray `node` in the process list can be traced to a run.
 */
export interface ProcessCorrelation {
  readonly workspaceId?: string;
  readonly missionId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly targetId?: string;
  readonly role?: string;
}

export interface ProcessSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  /** Extra variables, merged over the allowlisted base environment. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Inherit the daemon's entire environment instead of the allowlist.
   *
   * Legitimate only for a process the user has explicitly configured to need
   * ambient credentials - an agent CLI that reads a vendor token from the shell
   * the daemon was launched from, or a build that depends on a developer's
   * toolchain exports. Everything else must pass what it needs through `env`:
   * minimal environment propagation is the mitigation for credential leakage
   * into agent-visible processes (MVP.md §32).
   */
  readonly inheritEnv?: boolean;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Milliseconds between SIGTERM and SIGKILL during cancellation. */
  readonly killGraceMs?: number;
  /** Emit a heartbeat this often while the process lives. */
  readonly heartbeatMs?: number;
  readonly onHeartbeat?: (beat: ProcessHeartbeat) => void;
  /** Short label used in logs, e.g. `git worktree add`. */
  readonly label?: string;
  readonly correlation?: ProcessCorrelation;
}

export interface ProcessHeartbeat {
  readonly id: string;
  readonly pid: number;
  readonly label: string;
  readonly uptimeMs: number;
  readonly bytesOut: number;
  readonly bytesErr: number;
  /** Epoch ms of the last byte seen on either stream; null if silent so far. */
  readonly lastOutputAt: number | null;
}

export interface ProcessExit {
  readonly exitCode: number;
  readonly signal: string | null;
  readonly timedOut: boolean;
  /** Set when the exit was caused by `kill()` or an abort signal. */
  readonly killedReason: string | null;
  readonly durationMs: number;
}

export interface SupervisedProcess {
  readonly id: string;
  readonly pid: number;
  readonly label: string;
  readonly cwd: string;
  readonly startedAt: Timestamp;
  readonly correlation: ProcessCorrelation;
  /** Complete lines, in order. Safe for lines far larger than a pipe buffer. */
  stdout(): AsyncIterable<string>;
  stderr(): AsyncIterable<string>;
  wait(): Promise<ProcessExit>;
  /** Graceful close of stdin, then SIGTERM, then SIGKILL after the grace period. */
  kill(reason: string, options?: { graceMs?: number }): Promise<ProcessExit>;
}

export interface LiveProcess {
  readonly id: string;
  readonly pid: number;
  readonly label: string;
  readonly cwd: string;
  readonly startedAt: Timestamp;
  readonly correlation: ProcessCorrelation;
}

/**
 * The one place a child process is created (MVP.md §21.1).
 *
 * Centralising it is what makes environment control, cancellation escalation,
 * heartbeats and orphan detection properties of the *system* rather than habits
 * of whoever wrote the last adapter.
 */
export interface ProcessSupervisor {
  spawn(spec: ProcessSpec): SupervisedProcess;
  /** Spawn, buffer both streams, wait. The common case; uses `spawn` underneath. */
  run(
    spec: ProcessSpec,
    onOutput?: (chunk: string, stream: OutputStream) => void,
  ): Promise<ExecResult>;
  /** Everything still running, for startup orphan detection and diagnostics. */
  liveProcesses(): readonly LiveProcess[];
  /** Coordinated shutdown: escalates every live process to exit. */
  killAll(reason: string): Promise<void>;
}

/**
 * Variables forwarded to every child unless `inheritEnv` is set. Deliberately
 * minimal: enough for a POSIX toolchain to find its binaries, its home config
 * and a scratch directory, and nothing that commonly holds a token.
 */
export const BASE_ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ',
];

/**
 * Builds a child environment from the allowlist plus explicit additions.
 * Exported so a policy layer can assert on exactly what a worker will see.
 */
export function buildProcessEnv(
  spec: Pick<ProcessSpec, 'env' | 'inheritEnv'>,
  ambient: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = spec.inheritEnv ? Object.keys(ambient) : BASE_ENV_ALLOWLIST;
  for (const key of keys) {
    const value = ambient[key];
    if (value !== undefined) out[key] = value;
  }
  for (const [key, value] of Object.entries(spec.env ?? {})) out[key] = value;
  return out;
}
