import type {
  ExecutionTargetId, MissionId, RunId, RuntimeProfileId, TaskId, Timestamp,
  WorkerAssignmentId, WorkspaceId,
} from '@tandemise/shared';
import type { Capability } from '../capability.js';

/**
 * The temporary binding of Role + Runtime + Target + permissions for one run
 * (MVP.md §8). This is the unit permissions attach to: not the role (too
 * coarse), not the runtime (wrong axis), but this specific piece of work.
 */
export interface WorkerAssignment {
  readonly id: WorkerAssignmentId;
  readonly workspaceId: WorkspaceId;
  readonly missionId: MissionId;
  readonly taskId: TaskId;
  readonly roleId: string;
  readonly runtimeProfileId: RuntimeProfileId;
  readonly executionTargetId: ExecutionTargetId;
  readonly grants: readonly CapabilityGrant[];
  readonly budgets: AssignmentBudgets;
  readonly createdAt: Timestamp;
}

export interface AssignmentBudgets {
  readonly maxWallTimeMs: number;
  readonly maxAttempts: number;
}

/** MVP.md §27.4. */
export interface CapabilityGrant {
  readonly capability: Capability;
  /** Paths, domains, repositories, or app bundle ids the grant is limited to. */
  readonly resourceScope: readonly string[];
  readonly approvalMode: 'auto' | 'ask' | 'deny';
  readonly expiresAt: Timestamp | null;
  readonly reason?: string;
}

export function grant(
  capability: Capability,
  resourceScope: readonly string[] = [],
  approvalMode: CapabilityGrant['approvalMode'] = 'auto',
): CapabilityGrant {
  return { capability, resourceScope, approvalMode, expiresAt: null };
}

/** Everything a runtime adapter needs to execute one attempt. */
export interface RunContext {
  readonly runId: RunId;
  readonly assignment: WorkerAssignment;
  readonly workingDirectory: string;
  /** The compiled, trust-labelled prompt (MVP.md §14.1). */
  readonly prompt: string;
  /** Session handle to resume from, when the previous attempt was resumable. */
  readonly resumeFrom: string | null;
}
