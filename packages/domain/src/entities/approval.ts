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
/**
 * Yes, and do not ask again for this capability while this task's run lasts.
 * Offered on tool approvals: a design run through a connected app makes a
 * dozen calls, and a card per call trains people to click without reading.
 */
export const APPROVE_FOR_TASK_OPTION = 'approve_for_task';
/**
 * On a task that exhausted its retries: accept what it produced and let the
 * mission continue. The answer when the work is sound and the gate is what
 * cannot be met - a QA gate requiring 100% coverage of a criterion that is only
 * checkable after a later task opens the pull request.
 */
export const ACCEPT_RESULT_OPTION = 'accept_result';

/**
 * Whether deciding `optionId` means the request was granted.
 *
 * An `action` or `release` card is a yes/no question, so only `approve` is a
 * yes. A `choice` is not: the options *are* the answer, and a worker that asked
 * "Figma, Canva, or Claude?" must not have "Figma" read back to it as a
 * refusal. Anything other than an explicit decline answers a choice.
 *
 * Keeping the rule here rather than at the decision site is what stops the two
 * meanings drifting apart - the approval service, the tool that is blocked on
 * the answer, and the timeline all have to agree on what the human just did.
 */
export function isAffirmative(kind: ApprovalKind, optionId: string): boolean {
  return kind === 'choice'
    ? optionId !== REJECT_OPTION
    : optionId === APPROVE_OPTION || optionId === APPROVE_FOR_TASK_OPTION || optionId === ACCEPT_RESULT_OPTION;
}

export const DEFAULT_APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { id: APPROVE_OPTION, label: 'Approve', recommended: true },
  { id: REJECT_OPTION, label: 'Reject' },
];
