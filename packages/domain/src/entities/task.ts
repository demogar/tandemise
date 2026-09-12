import type { MissionId, RepositoryId, TaskId, Timestamp } from '@tandemise/shared';
import type { Capability } from '../capability.js';
import type { ArtifactType } from './artifact.js';
import type { GateExpression } from '../gate.js';

/** Who carries a task out (MVP.md §11). */
export const TASK_EXECUTORS = ['agent', 'human', 'wait'] as const;
export type TaskExecutor = (typeof TASK_EXECUTORS)[number];

export const TASK_STATUSES = [
  'PENDING',       // dependencies not yet satisfied
  'READY',         // eligible to be scheduled
  'RUNNING',
  'AWAITING_HUMAN',    // a person has to do this one
  'AWAITING_EXTERNAL', // polling something outside this machine
  'AWAITING_APPROVAL',
  'BLOCKED',       // needs human intervention or an unmet gate
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] =
  ['READY', 'RUNNING', 'AWAITING_HUMAN', 'AWAITING_EXTERNAL', 'AWAITING_APPROVAL'];
export const FINISHED_TASK_STATUSES: readonly TaskStatus[] = ['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'];

export function isTaskFinished(s: TaskStatus): boolean {
  return FINISHED_TASK_STATUSES.includes(s);
}

/** Where a task's work must happen (MVP.md §11). */
/**
 * What a `wait` step watches.
 *
 * A shell command rather than a typed integration on purpose: the thing being
 * waited for is different every time - `gh pr checks`, a curl against a health
 * endpoint, a vendor CLI - and any list this repository shipped would be the
 * wrong list for someone. Exit code 0 means the wait is over.
 */
export interface WaitPolicy {
  /** Run in the task's repository. Exit 0 ends the wait. */
  readonly command: string;
  readonly everyMs: number;
  /** Give up and fail the task after this long. */
  readonly timeoutMs: number;
}

export const DEFAULT_WAIT_EVERY_MS = 30_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 1_800_000;

export const ISOLATION_MODES = ['none', 'worktree', 'docker', 'browser'] as const;
export type IsolationMode = (typeof ISOLATION_MODES)[number];

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs: number;
  /** After exhausting attempts: block for a human, or fail the task outright. */
  readonly onExhausted: 'block' | 'fail';
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 2, backoffMs: 5_000, onExhausted: 'block' };

export interface ExecutionPolicy {
  readonly isolation: IsolationMode;
  readonly maxWallTimeMs: number;
  /** Capabilities the worker may use. Enforced as grants, not suggestions. */
  readonly capabilities: readonly Capability[];
}

export interface ApprovalPolicy {
  /** Approval demanded before the task starts (e.g. a release action). */
  readonly beforeStart: boolean;
  /** Approval demanded for the task's outputs before dependents may run. */
  readonly onCompletion: boolean;
  readonly reason?: string;
}

export const NO_APPROVAL: ApprovalPolicy = { beforeStart: false, onCompletion: false };

export interface ArtifactRequirement {
  readonly type: ArtifactType;
  /** When false the task runs even if no artifact of this type exists. */
  readonly required: boolean;
}

export interface MissionTask {
  readonly id: TaskId;
  readonly missionId: MissionId;
  /**
   * The repository this task works in, or null for the mission's own.
   *
   * A project is frequently several repositories that ship together, and one
   * change lands in more than one of them. Letting a task name its repository
   * is what keeps that a single mission with a single dependency graph, rather
   * than separate missions that cannot wait on each other.
   */
  readonly repositoryId: RepositoryId | null;
  /** `human` and `wait` tasks are never dispatched to a runtime. */
  readonly executor: TaskExecutor;
  /** Set only for a `wait` task: what it polls, and for how long. */
  readonly waitPolicy: WaitPolicy | null;
  /** Stable, plan-author-supplied key (`implement_onboarding`). Unique per mission. */
  readonly key: string;
  readonly title: string;
  readonly objective: string;
  readonly roleId: string;
  readonly dependsOn: readonly string[];
  readonly requiredCapabilities: readonly Capability[];
  readonly inputArtifacts: readonly ArtifactRequirement[];
  readonly expectedOutputs: readonly ArtifactType[];
  readonly executionPolicy: ExecutionPolicy;
  readonly approvalPolicy: ApprovalPolicy;
  readonly retryPolicy: RetryPolicy;
  readonly completionGate: GateExpression | null;
  readonly status: TaskStatus;
  readonly statusReason: string | null;
  readonly attempts: number;
  /** Present when this task was generated to fix findings from another task. */
  readonly remediatesTaskId: TaskId | null;
  readonly orderHint: number;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly startedAt: Timestamp | null;
  readonly finishedAt: Timestamp | null;
}
