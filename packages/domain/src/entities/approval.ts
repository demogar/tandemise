import type { ApprovalId, MissionId, RunId, TaskId, Timestamp, WorkspaceId } from '@tandemise/shared';
import type { RiskClass } from '../capability.js';

/** MVP.md §18.3. */
export const APPROVAL_KINDS = [
  'plan',          // approve or edit the proposed mission plan
  'choice',        // pick among product/design/architecture alternatives
  'exception',     // temporarily grant permission outside default policy
  'action',        // authorize one classified side effect
  'release',       // authorize merge / deploy / publish
  'intervention',  // a worker is stuck and needs a human
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface ApprovalOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly recommended?: boolean;
}

/**
 * Everything a human needs to decide without opening five agent transcripts
 * (MVP.md §23.4). If a field here is empty, the approval card is not ready to be
 * shown - that is a deliberate design constraint, not an optional nicety.
 */
export interface Approval {
  readonly id: ApprovalId;
  readonly workspaceId: WorkspaceId;
  readonly missionId: MissionId | null;
  readonly taskId: TaskId | null;
  readonly runId: RunId | null;
  readonly kind: ApprovalKind;
  readonly status: ApprovalStatus;
  readonly risk: RiskClass;
  /** What is being requested, in one line. */
  readonly title: string;
  /** Why it is being requested. */
  readonly rationale: string;
  /** Exactly what will happen if approved. */
  readonly effect: string;
  /** Evidence supporting the request: artifact ids, diffs, check results. */
  readonly evidence: readonly ApprovalEvidence[];
  readonly options: readonly ApprovalOption[];
  readonly recommendedOptionId: string | null;
  readonly selectedOptionId: string | null;
  readonly decidedBy: string | null;
  readonly decisionNote: string | null;
  readonly createdAt: Timestamp;
  readonly decidedAt: Timestamp | null;
  readonly expiresAt: Timestamp | null;
}

export interface ApprovalEvidence {
  readonly kind: 'artifact' | 'check' | 'diff' | 'link' | 'text';
  readonly label: string;
  readonly value: string;
}

export const APPROVE_OPTION = 'approve';
export const REJECT_OPTION = 'reject';

export const DEFAULT_APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { id: APPROVE_OPTION, label: 'Approve', recommended: true },
  { id: REJECT_OPTION, label: 'Reject' },
];
