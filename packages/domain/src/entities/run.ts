import type { MissionId, RunId, TaskId, Timestamp, WorkerAssignmentId } from '@tandemise/shared';
import type { RunPurpose } from './feedback.js';
import type { RunSkill } from './skill.js';

export const RUN_STATUSES = [
  'STARTING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED',
  /** Daemon exited mid-run; the child process is gone. */
  'INTERRUPTED',
  /** Interrupted, but the runtime exposes a session we can resume (MVP.md §21.2). */
  'RESUMABLE',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const LIVE_RUN_STATUSES: readonly RunStatus[] = ['STARTING', 'RUNNING'];

export interface Run {
  readonly id: RunId;
  readonly missionId: MissionId;
  readonly taskId: TaskId;
  readonly assignmentId: WorkerAssignmentId;
  readonly attempt: number;
  readonly status: RunStatus;
  readonly roleId: string;
  readonly runtimeProfileId: string;
  readonly executionTargetId: string;
  /**
   * Opaque, runtime-supplied session handle (a Claude Code session id, say).
   * Persisting it is what makes resume possible; it is an identifier, never a
   * credential (MVP.md §10.3).
   */
  readonly externalSessionId: string | null;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly usage: RunUsage | null;
  readonly startedAt: Timestamp;
  readonly finishedAt: Timestamp | null;
  readonly heartbeatAt: Timestamp | null;
  /**
   * When the agent last wrote an event (P9); the run's start until it does.
   * Optional so builders written before P9 still compile; read back as the start.
   */
  readonly lastEventAt?: Timestamp | null;
  /** "Keep waiting" on a quiet run: its Inbox row stays hidden until then. Any agent event clears it. */
  readonly watchSnoozedUntil?: Timestamp | null;
  /** The agent member the run acted as, or null for a legacy runtime-only dispatch. */
  readonly agentMemberId?: string | null;
  /** The task round this run belongs to; null for a run from before migration 010. */
  readonly round?: number | null;
  /** Why this run exists; null for the same reason as `round`. */
  readonly purpose?: RunPurpose | null;
  /** The model the run was given (P12); null = the runtime's own default. */
  readonly model?: string | null;
  /** Why that model: "step override", "retry escalation (attempt 2)"… Null for a run from before P12. */
  readonly modelReason?: string | null;
  /** The skills the run received, and how (P13). Null for a run from before P13. */
  readonly skills?: readonly RunSkill[] | null;
}

/**
 * Usage as *observed*, not as invoiced. Subscription-based runtimes do not
 * expose a trustworthy per-run cost, so `costUsd` stays null rather than being
 * fabricated (MVP.md §22.2).
 */
export interface RunUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number | null;
  readonly wallTimeMs?: number;
  readonly turns?: number;
}

/** A durable point a retry can restart from without redoing side effects. */
export interface Checkpoint {
  readonly runId: RunId;
  readonly sequence: number;
  readonly label: string;
  readonly externalSessionId: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Timestamp;
}
