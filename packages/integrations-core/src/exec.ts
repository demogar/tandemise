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
