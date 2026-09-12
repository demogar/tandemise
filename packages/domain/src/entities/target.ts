import type { ExecutionTargetId, MissionId, TaskId, Timestamp, WorkspaceId } from '@tandemise/shared';

/** MVP.md §11.1. `remote` is defined but not implemented in v0.1. */
export const TARGET_KINDS = ['local', 'worktree', 'docker', 'browser', 'remote'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const TARGET_STATUSES = ['PROVISIONING', 'READY', 'IN_USE', 'RELEASED', 'FAILED'] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

export interface ExecutionTargetRecord {
  readonly id: ExecutionTargetId;
  readonly workspaceId: WorkspaceId;
  readonly missionId: MissionId | null;
  readonly taskId: TaskId | null;
  readonly kind: TargetKind;
  readonly name: string;
  /** Working directory for the target. For a worktree, the worktree root. */
  readonly workingDirectory: string;
  readonly branch: string | null;
  readonly baseBranch: string | null;
  readonly status: TargetStatus;
  readonly detail: string | null;
  readonly createdAt: Timestamp;
  readonly releasedAt: Timestamp | null;
}

/**
 * An exclusive claim on a shared resource - a branch, a repository, a desktop
 * application, a browser profile. Leases are what stop two developer runs from
 * writing the same tree (MVP.md §9.4, §21.1).
 */
export interface ResourceLease {
  readonly id: string;
  readonly resourceKey: string;
  readonly holderRunId: string | null;
  readonly holderTaskId: string | null;
  readonly acquiredAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly heartbeatAt: Timestamp;
}
