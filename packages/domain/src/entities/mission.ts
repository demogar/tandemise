import type { EvalTrialId, IssueLinkId, MissionId, RepositoryId, RoutineId, TaskId, WorkspaceId, Timestamp } from '@tandemise/shared';
import type { Capability } from '../capability.js';
import type { RoleStaffing } from '../staffing.js';
import type { MissionPriority } from './backlog.js';
import type { Limit } from './limits.js';

/** MVP.md §9.1. Terminal states are RELEASED-adjacent or explicit failures. */
export const MISSION_STATUSES = [
  'DRAFT', 'PLANNING', 'AWAITING_PLAN_APPROVAL', 'EXECUTING', 'REVIEWING',
  'QA', 'READY_TO_SHIP', 'RELEASED', 'OBSERVING', 'COMPLETE',
  'BLOCKED', 'PAUSED', 'FAILED', 'CANCELLED',
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const TERMINAL_MISSION_STATUSES: readonly MissionStatus[] = [
  'COMPLETE', 'FAILED', 'CANCELLED',
];

export function isTerminalMissionStatus(s: MissionStatus): boolean {
  return TERMINAL_MISSION_STATUSES.includes(s);
}

/**
 * Legal mission transitions. Centralising this prevents the scheduler, the API,
 * and the recovery path from each inventing their own idea of what may follow
 * what - the class of bug that leaves a mission permanently stuck.
 */
const TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
  DRAFT: ['PLANNING', 'CANCELLED'],
  // PAUSED from either: a paused mission's replan of the rest goes back to paused when it is
  // rejected or cannot be planned (replan spec), rather than starting work nobody resumed.
  PLANNING: ['AWAITING_PLAN_APPROVAL', 'EXECUTING', 'FAILED', 'CANCELLED', 'BLOCKED', 'PAUSED'],
  // BLOCKED is where a rejected plan leaves the mission, until it is re-planned or its goal changes.
  AWAITING_PLAN_APPROVAL: ['EXECUTING', 'PLANNING', 'BLOCKED', 'CANCELLED', 'FAILED', 'PAUSED'],
  // PLANNING from EXECUTING is a replan of the rest (replan spec), refused while a run is live.
  EXECUTING: ['REVIEWING', 'QA', 'READY_TO_SHIP', 'BLOCKED', 'PAUSED', 'FAILED', 'CANCELLED', 'COMPLETE', 'PLANNING'],
  REVIEWING: ['EXECUTING', 'QA', 'BLOCKED', 'PAUSED', 'FAILED', 'CANCELLED'],
  QA: ['EXECUTING', 'READY_TO_SHIP', 'BLOCKED', 'PAUSED', 'FAILED', 'CANCELLED'],
  READY_TO_SHIP: ['RELEASED', 'EXECUTING', 'COMPLETE', 'BLOCKED', 'PAUSED', 'CANCELLED'],
  RELEASED: ['OBSERVING', 'COMPLETE'],
  OBSERVING: ['COMPLETE'],
  // Reopened when a person retries one of its tasks: finished is not the same
  // as final, and a mission marked complete in error must be recoverable.
  COMPLETE: ['EXECUTING'],
  BLOCKED: ['EXECUTING', 'REVIEWING', 'QA', 'PLANNING', 'READY_TO_SHIP', 'PAUSED', 'CANCELLED', 'FAILED'],
  PAUSED: ['EXECUTING', 'REVIEWING', 'QA', 'PLANNING', 'READY_TO_SHIP', 'CANCELLED'],
  FAILED: ['PLANNING', 'EXECUTING', 'CANCELLED'],
  CANCELLED: [],
};

export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  return from === to || (TRANSITIONS[from] ?? []).includes(to);
}

export function allowedTransitions(from: MissionStatus): readonly MissionStatus[] {
  return TRANSITIONS[from] ?? [];
}

/** How much the mission may do without asking (MVP.md Appendix A). */
export const AUTONOMY_LEVELS = ['supervised', 'balanced', 'autonomous'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export interface Mission {
  readonly id: MissionId;
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: RepositoryId | null;
  readonly title: string;
  /** The user's original natural-language intent, preserved verbatim. */
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly successCriteria: readonly string[];
  readonly status: MissionStatus;
  readonly autonomy: AutonomyLevel;
  /**
   * Which workflow this mission runs.
   *
   * Resolved against the project's own workflow files first and the built-in
   * presets second, so a team that writes `build-feature.yaml` gets theirs
   * rather than one shipped in this repository.
   */
  readonly workflowPreset: string;
  /** Values the workflow's declared inputs were given. */
  readonly workflowInputs: Readonly<Record<string, string>>;
  /** Branch that successful task branches are integrated into (MVP.md §11.3). */
  readonly integrationBranch: string | null;
  readonly baseBranch: string | null;
  readonly statusReason: string | null;
  /** The member who started the mission, or null for one created before members existed. */
  readonly createdBy?: string | null;
  /** Per-role staffing for this mission, layered over the workspace's. */
  readonly staffing?: RoleStaffing;
  /** Orders the backlog and worker slots (P7). */
  readonly priority: MissionPriority;
  /** Place inside its priority; lower first. */
  readonly rank: number;
  /** Set while a DRAFT is queued to be planned when there is room; null otherwise. */
  readonly queuedAt: Timestamp | null;
  /**
   * The mission's own ceilings on agent time, tokens or reported cost (P8).
   * Null means the project's default mission limits apply.
   */
  readonly limits: readonly Limit[] | null;
  /** The routine that created it (P11); null for a mission a person created. */
  readonly routineId: RoutineId | null;
  /** The GitHub issue it was created from (P14); absent or null for any other mission. */
  readonly issueLinkId?: IssueLinkId | null;
  /** Set only on a hidden eval trial mission (P3b). Such a mission is never listed, scheduled or escalated. */
  readonly evalTrialId?: EvalTrialId | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly startedAt: Timestamp | null;
  readonly completedAt: Timestamp | null;
}

/** Whether `m` is a hidden eval trial mission (P3b): never listed, scheduled or escalated. */
export function isTrialMission(m: Pick<Mission, 'evalTrialId'> | undefined): boolean {
  return m !== undefined && m.evalTrialId !== undefined && m.evalTrialId !== null;
}

export interface MissionDraft {
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: RepositoryId | null;
  readonly title: string;
  readonly goal: string;
  readonly constraints?: readonly string[];
  readonly successCriteria?: readonly string[];
  readonly autonomy?: AutonomyLevel;
  readonly workflowPreset?: string;
  readonly workflowInputs?: Readonly<Record<string, string>>;
  readonly baseBranch?: string | null;
  readonly createdBy?: string | null;
  readonly staffing?: RoleStaffing;
  /** Defaults to normal. */
  readonly priority?: MissionPriority;
  /** Defaults to last in the project. */
  readonly rank?: number;
  /** Queued at creation ("Add to backlog"). */
  readonly queued?: boolean;
  /** The mission's own limits; absent or null uses the project's defaults. */
  readonly limits?: readonly Limit[] | null;
  /** Set when a routine creates it (P11). */
  readonly routineId?: RoutineId | null;
  /** Set when an issue creates it (P14). */
  readonly issueLinkId?: IssueLinkId | null;
  /** Set only on a hidden eval trial mission (P3b). */
  readonly evalTrialId?: EvalTrialId | null;
}

/** Aggregate counters projected for the mission list, computed not stored. */
export interface MissionProgress {
  readonly totalTasks: number;
  readonly completed: number;
  readonly running: number;
  readonly blocked: number;
  readonly failed: number;
  readonly pendingApprovals: number;
}

export interface MissionCapabilityRequirement {
  readonly taskId: TaskId;
  readonly capabilities: readonly Capability[];
}
