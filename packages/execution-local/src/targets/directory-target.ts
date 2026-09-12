import type { ExecutionTargetId, Logger } from '@tandemise/shared';
import type { ExecutionTargetRecord, TargetKind } from '@tandemise/domain';
import {
  ScopedFileSystem,
  formatCommand,
  type ExecRequest,
  type ExecResult,
  type ExecutionTarget,
  type FileSystemHandle,
  type ProcessCorrelation,
  type ProcessSupervisor,
  type TargetCapability,
} from '@tandemise/execution-core';

export interface DirectoryTargetOptions {
  readonly record: ExecutionTargetRecord;
  readonly supervisor: ProcessSupervisor;
  readonly log: Logger;
  readonly capabilities: readonly TargetCapability[];
  /** Variables every command in this target receives (e.g. a worktree marker). */
  readonly env?: Readonly<Record<string, string>>;
  /** Additional roots the filesystem handle may touch, beyond the root itself. */
  readonly extraRoots?: readonly string[];
}

/**
 * A target that is simply a directory on this machine.
 *
 * `local` and `worktree` differ only in how the directory comes to exist and
 * what release means; once provisioned, running a command in a worktree is
 * running a command in a directory. Sharing one implementation keeps that
 * honest instead of duplicating exec/filesystem mechanics per kind.
 */
export class DirectoryExecutionTarget implements ExecutionTarget {
  readonly id: ExecutionTargetId;
  readonly kind: TargetKind;
  readonly workingDirectory: string;

  readonly #fs: ScopedFileSystem;
  readonly #capabilities: readonly TargetCapability[];
  readonly #options: DirectoryTargetOptions;
  #record: ExecutionTargetRecord;

  constructor(options: DirectoryTargetOptions) {
    this.#options = options;
    this.#record = options.record;
    this.id = options.record.id;
    this.kind = options.record.kind;
    this.workingDirectory = options.record.workingDirectory;
    this.#capabilities = options.capabilities;
    this.#fs = new ScopedFileSystem(this.workingDirectory, options.extraRoots ?? []);
  }

  capabilities(): readonly TargetCapability[] {
    return this.#capabilities;
  }

  filesystem(): FileSystemHandle {
    return this.#fs;
  }

  describe(): ExecutionTargetRecord {
    return this.#record;
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    // A relative cwd is resolved *and scoped*: a command must not be able to
    // step outside the target by asking for one.
    const cwd = await this.#fs.resolve(request.cwd ?? '.');
    const correlation: ProcessCorrelation = {
      targetId: this.id,
      workspaceId: this.#record.workspaceId,
      missionId: this.#record.missionId ?? undefined,
      taskId: this.#record.taskId ?? undefined,
    };
    return this.#options.supervisor.run(
      {
        command: request.command,
        args: request.args,
        cwd,
        env: { ...this.#options.env, ...request.env },
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        stdin: request.stdin,
        label: formatCommand(request.command, request.args),
        correlation,
      },
      request.onOutput,
    );
  }

  /** Called by the factory when provisioning refreshes the persisted view. */
  updateRecord(record: ExecutionTargetRecord): void {
    this.#record = record;
  }

  async dispose(): Promise<void> {
    // Nothing in-process outlives an `exec`; the workspace on disk is the
    // factory's to release, precisely so disposal can never destroy work.
    this.#options.log.debug('target.disposed', { targetId: this.id, kind: this.kind });
  }
}
