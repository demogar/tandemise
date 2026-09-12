import type { ExecutionTargetId } from '@tandemise/shared';
import type { ExecutionTargetRecord, TargetKind } from '@tandemise/domain';
import type { FileSystemHandle } from './filesystem.js';

export type OutputStream = 'stdout' | 'stderr';

/**
 * What a target is able to do. Descriptive, never authoritative: a target
 * offering `git` says nothing about whether a worker is *permitted* to commit -
 * that is a grant (MVP.md §10.5).
 */
export const TARGET_CAPABILITIES = [
  'exec',
  'filesystem',
  'git',
  /** Writes land somewhere the user's own checkout cannot see (MVP.md §11.2). */
  'isolated-workspace',
  'browser',
  'desktop',
] as const;
export type TargetCapability = (typeof TARGET_CAPABILITIES)[number];

export interface ExecRequest {
  readonly command: string;
  readonly args?: readonly string[];
  /** Relative paths resolve against - and are scoped to - the target root. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly stdin?: string;
  /** Streamed as it arrives; the full text is still returned in ExecResult. */
  readonly onOutput?: (chunk: string, stream: OutputStream) => void;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** The command line as executed, for audit trails and error messages. */
  readonly command: string;
}

/**
 * Where work happens (MVP.md §11.1). The orchestrator never calls `spawn` or
 * `fs` directly; it holds an ExecutionTarget, which is the only thing that
 * knows whether "run the tests" means a local directory, a git worktree, or a
 * container.
 */
export interface ExecutionTarget {
  readonly id: ExecutionTargetId;
  readonly kind: TargetKind;
  readonly workingDirectory: string;
  capabilities(): readonly TargetCapability[];
  exec(request: ExecRequest): Promise<ExecResult>;
  filesystem(): FileSystemHandle;
  /** The persistable view of this target, for the repository and the UI. */
  describe(): ExecutionTargetRecord;
  /** Releases in-process resources. Does *not* destroy the workspace on disk. */
  dispose(): Promise<void>;
}

/** Human-readable command line. Quoting is for display only, never for exec. */
export function formatCommand(command: string, args: readonly string[] = []): string {
  const quoted = args.map((a) => (/[\s"'$`\\]/.test(a) ? JSON.stringify(a) : a));
  return [command, ...quoted].join(' ');
}
