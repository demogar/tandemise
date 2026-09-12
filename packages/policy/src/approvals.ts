import type {
  Approval, ApprovalEvidence, ApprovalKind, ApprovalOption, RiskClass,
} from '@tandemise/domain';
import { APPROVE_OPTION, DEFAULT_APPROVAL_OPTIONS, REJECT_OPTION } from '@tandemise/domain';
import type {
  ApprovalId, Clock, MissionId, Result, RunId, TaskId, WorkspaceId,
} from '@tandemise/shared';
import { Err, Ok, TandemiseError, ids, systemClock } from '@tandemise/shared';
import type { PolicyDecision, PolicyRequest } from './engine.js';

/**
 * Builds approval cards (MVP.md §18.1, §23.4).
 *
 * MVP.md §23.4 states the approval card must carry concise evidence, a
 * recommendation, alternatives, risk, and the exact action that will occur if
 * approved. That is a product requirement, so it is enforced here as a
 * construction precondition rather than left to whoever happens to build an
 * approval: an approval missing its rationale, its effect, or its evidence
 * cannot be constructed at all. The failure mode this prevents is an inbox full
 * of cards a human cannot actually decide on, which quietly converts human
 * authority into rubber-stamping.
 */
export interface ApprovalDraft {
  readonly workspaceId: WorkspaceId;
  readonly missionId?: MissionId | null;
  readonly taskId?: TaskId | null;
  readonly runId?: RunId | null;
  readonly kind: ApprovalKind;
  readonly risk: RiskClass;
  readonly title: string;
  readonly rationale: string;
  readonly effect: string;
  readonly evidence: readonly ApprovalEvidence[];
  readonly options?: readonly ApprovalOption[];
  readonly recommendedOptionId?: string | null;
  readonly expiresAt?: string | null;
}

export interface ApprovalFactory {
  /** `Err` lists every missing field at once, so a caller fixes them in one pass. */
  create(draft: ApprovalDraft): Result<Approval, readonly string[]>;
  /** For call sites where an incomplete draft is a programming error. */
  createOrThrow(draft: ApprovalDraft): Approval;
  /** Turns a `require_approval` policy decision into a ready-to-show card. */
  forDecision(input: DecisionApprovalInput): Approval;
}

export interface DecisionApprovalInput {
  readonly workspaceId: WorkspaceId;
  readonly missionId: MissionId | null;
  readonly taskId: TaskId | null;
  readonly runId: RunId | null;
  readonly decision: PolicyDecision;
  readonly request: PolicyRequest;
  /** Plain-language description of what will happen. Required - see above. */
  readonly effect: string;
  readonly extraEvidence?: readonly ApprovalEvidence[];
}

export function createApprovalFactory(options: { clock?: Clock } = {}): ApprovalFactory {
  const clock = options.clock ?? systemClock;

  const create = (draft: ApprovalDraft): Result<Approval, readonly string[]> => {
    const missing = validateDraft(draft);
    if (missing.length > 0) return Err(missing);

    const optionList = draft.options && draft.options.length > 0 ? draft.options : DEFAULT_APPROVAL_OPTIONS;
    const recommended = draft.recommendedOptionId
      ?? optionList.find((o) => o.recommended)?.id
      ?? null;

    return Ok({
      id: ids.approval() as ApprovalId,
      workspaceId: draft.workspaceId,
      missionId: draft.missionId ?? null,
      taskId: draft.taskId ?? null,
      runId: draft.runId ?? null,
      kind: draft.kind,
      status: 'PENDING',
      risk: draft.risk,
      title: draft.title.trim(),
      rationale: draft.rationale.trim(),
      effect: draft.effect.trim(),
      evidence: draft.evidence,
      options: optionList,
      recommendedOptionId: recommended,
      selectedOptionId: null,
      decidedBy: null,
      decisionNote: null,
      createdAt: clock.now(),
      decidedAt: null,
      expiresAt: draft.expiresAt ?? null,
    });
  };

  return {
    create,
    createOrThrow(draft: ApprovalDraft): Approval {
      const result = create(draft);
      if (result.ok) return result.value;
      throw TandemiseError.validation(
        `Approval card is incomplete and cannot be shown to a human: ${result.error.join(', ')}`,
        { missing: result.error, title: draft.title },
      );
    },
    forDecision(input: DecisionApprovalInput): Approval {
      const { decision, request } = input;
      const target = request.resource ?? request.command ?? request.capability;
      const evidence: ApprovalEvidence[] = [
        { kind: 'text', label: 'Capability', value: request.capability },
        { kind: 'text', label: 'Target', value: target },
        { kind: 'text', label: 'Policy reason', value: decision.reason },
        ...(request.command ? [{ kind: 'text' as const, label: 'Command', value: request.command }] : []),
        ...(decision.assessment.shell?.matches ?? []).map((m) => ({
          kind: 'text' as const,
          label: `Risk rule: ${m.rule}`,
          value: m.detail,
        })),
        ...(input.extraEvidence ?? []),
      ];

      return createOrThrowInternal({
        workspaceId: input.workspaceId,
        missionId: input.missionId,
        taskId: input.taskId,
        runId: input.runId,
        kind: decision.risk === 'release' ? 'release' : 'action',
        risk: decision.risk,
        title: `Allow ${request.capability} on ${truncate(target, 64)}?`,
        rationale: decision.reason,
        effect: input.effect,
        evidence,
        options: [
          { id: APPROVE_OPTION, label: 'Approve once', description: input.effect },
          { id: REJECT_OPTION, label: 'Reject', description: 'The worker is told the action was refused and continues without it.' },
        ],
        // Deliberately no default recommendation: the whole point of a
        // destructive/release gate is that Tandemise is not confident enough to
        // pick for the human.
        recommendedOptionId: null,
      });
    },
  };

  function createOrThrowInternal(draft: ApprovalDraft): Approval {
    const result = create(draft);
    if (result.ok) return result.value;
    throw TandemiseError.validation(
      `Approval card is incomplete and cannot be shown to a human: ${result.error.join(', ')}`,
      { missing: result.error },
    );
  }
}

function validateDraft(draft: ApprovalDraft): string[] {
  const missing: string[] = [];
  if (!nonEmpty(draft.title)) missing.push('title (one line saying what is being requested)');
  if (!nonEmpty(draft.rationale)) missing.push('rationale (why it is being requested)');
  if (!nonEmpty(draft.effect)) missing.push('effect (exactly what happens if approved)');
  if (draft.evidence.length === 0) missing.push('evidence (at least one artifact, check, diff, or link)');
  if (draft.evidence.some((e) => !nonEmpty(e.label) || !nonEmpty(e.value))) {
    missing.push('evidence entries must each have a label and a value');
  }
  if (draft.options && draft.options.length === 1) {
    missing.push('options (a single option is not a decision - offer at least approve and reject)');
  }
  return missing;
}

function nonEmpty(v: string | undefined | null): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
