/**
 * The command-execution port used by CLI-transport integrations.
 *
 * Deliberately a *narrow re-declaration* of what `@tandemise/execution-core`
 * already offers rather than an import of it: both packages sit on layer 3, so
 * the dependency direction forbids the import, and a tool that only needs "run
 * this and give me the output" should not depend on target provisioning. The
 * shapes are structurally compatible with `ExecutionTarget['exec']`, so the
 * composition root adapts one to the other without a wrapper.
 *
 * Nothing in this package spawns a process; the executor is always injected.
 */
export interface ToolExecRequest {
  readonly command: string;
  readonly args?: readonly string[];
  /** Relative paths resolve against - and are scoped to - the target root. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly stdin?: string;
}

export interface ToolExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** The command line as executed, for audit trails and error messages. */
  readonly command: string;
}

export interface CommandExecutor {
  run(request: ToolExecRequest): Promise<ToolExecResult>;
}

/** A process that outlives the call that started it - a dev server, a tunnel. */
export interface BackgroundProcess {
  readonly pid: number;
  /** Resolves when the process exits, however it exits. */
  readonly exited: Promise<{ readonly exitCode: number; readonly signal: string | null }>;
  /** Graceful termination, escalating to a kill. Safe to call more than once. */
  stop(reason: string): Promise<void>;
}

export interface BackgroundProcessSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Short label for logs, e.g. `dev server`. */
  readonly label?: string;
  readonly onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

/**
 * Starts long-lived child processes.
 *
 * Separate from `CommandExecutor` because the lifecycle is genuinely different:
 * a dev server has no exit code to wait for, and the caller needs a handle it
 * can stop. Implemented by the daemon over `ProcessSupervisor`, so a dev server
 * is reaped by the same shutdown path as everything else (MVP.md §21.1).
 */
export interface BackgroundProcessLauncher {
  launch(spec: BackgroundProcessSpec): BackgroundProcess;
}
