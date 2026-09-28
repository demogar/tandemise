import type {
  Approval, ApprovalRepositoryPort, AssignmentRepositoryPort, MissionRepositoryPort, MissionTask,
  RunRepositoryPort, TaskRepositoryPort, WorkerAssignment, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { APPROVE_FOR_TASK_OPTION, APPROVE_OPTION, DEFAULT_AUTONOMY, REJECT_OPTION, isTrialMission } from '@tandemise/domain';
import type { ApprovalFactory, PolicyEngine } from '@tandemise/policy';
import type {
  ApprovalGate, ToolApprovalDecision, ToolApprovalRequest, ToolPolicyDecision, ToolPolicyGate,
  ToolPolicyRequest,
} from '@tandemise/integrations-core';
import type { ApprovalId, Clock, Logger, WorkspaceId } from '@tandemise/shared';
import { summarize } from '@tandemise/shared';
import type { EventRecorder, EventScope } from './event-recorder.js';
import { withdrawApproval } from './withdraw.js';
import { runActorOf } from './run-actor.js';

export interface PolicyGateDeps {
  readonly policy: PolicyEngine;
  readonly assignments: AssignmentRepositoryPort;
  readonly workspaces: WorkspaceRepositoryPort;
  readonly recorder: EventRecorder;
  readonly log: Logger;
}

/**
 * The real enforcement point for tool use (MVP.md §19.2).
 *
 * `@tandemise/integrations-core` ships `denyAllPolicyGate` as its default and
 * `grantsPolicyGate` as a grants-only floor. Neither consults the policy engine,
 * so without this binding the engine's risk classification - the shell rules,
 * the autonomy dials, the destructive-action escalation - is computed and then
 * thrown away. Binding this to `TOOL_POLICY_GATE` is what turns
 * `POLICY_ENGINE` from a library into the decision point every tool call
 * actually passes through.
 *
 * A denial is recorded on the mission timeline as `policy.denied`, because a
 * worker that quietly loses a capability produces a mission that stalls for a
 * reason the user cannot see.
 */
export function createPolicyEngineToolGate(deps: PolicyGateDeps): ToolPolicyGate {
  return {
    async check(request: ToolPolicyRequest): Promise<ToolPolicyDecision> {
      const assignment = deps.assignments.get(request.assignmentId);
      if (assignment === undefined) {
        // An unknown assignment carries no grants, and default-deny means an
        // absent authorization input is a refusal rather than a fallback.
        return {
          outcome: 'deny',
          reason: `No worker assignment '${request.assignmentId}' is known; the call cannot be authorized.`,
          risk: request.risk,
        };
      }

      const workspace = deps.workspaces.get(assignment.workspaceId);
      const decision = deps.policy.evaluate({
        capability: request.capability,
        ...(request.resource !== undefined ? { resource: request.resource } : {}),
        grants: assignment.grants,
        autonomy: workspace?.autonomy ?? DEFAULT_AUTONOMY,
        assignmentId: assignment.id,
      });

      if (decision.outcome === 'deny') {
        deps.recorder.record(scopeOf(assignment), {
          type: 'policy.denied',
          capability: request.capability,
          reason: `${request.toolName}: ${decision.reason}`,
        });
      }
      return { outcome: decision.outcome, reason: decision.reason, risk: decision.risk };
    },
  };
}

export interface ApprovalGateDeps {
  readonly approvals: ApprovalRepositoryPort;
  readonly approvalFactory: ApprovalFactory;
  readonly assignments: AssignmentRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly waiter: ApprovalWaiter;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  /** Finds the run asking, whose agent is the event's actor. */
  readonly runs?: Pick<RunRepositoryPort, 'get' | 'listByTask'>;
  /**
   * Who a tool card is for and when it climbs the team tree - the same answer
   * every other card about the task gets. Absent in a composition with no
   * reviews wired: the card is then addressed to nobody and never escalates.
   */
  readonly address?: (task: MissionTask, workspaceId: WorkspaceId) => {
    readonly addressees: readonly string[];
    readonly escalateAfterMs: number | null;
  };
}

/**
 * Turns a `require_approval` decision into a card a human can answer, and waits
 * for the answer (MVP.md §18.1).
 *
 * Waiting is the whole point. `integrations-core` ships `denyingApprovalGate`
 * as its default, which is correct as a fallback but degrades every ask-mode
 * grant into a refusal - and a product whose approvals always say no has no
 * approval story at all.
 */
export function createApprovalGate(deps: ApprovalGateDeps): ApprovalGate {
  // Capabilities a person allowed for the rest of one assignment - one task's
  // attempt. In memory on purpose: it dies with the run it was given to, and a
  // restart asks again rather than trusting a yes nobody can see.
  const standing = new Map<string, Set<string>>();
  return {
    async requestApproval(request: ToolApprovalRequest, signal: AbortSignal): Promise<ToolApprovalDecision> {
      const assignment = deps.assignments.get(request.assignmentId);
      if (assignment === undefined) {
        return {
          approved: false,
          reason: `No worker assignment '${request.assignmentId}' is known.`,
          approvalId: null,
        };
      }
      // Never for a release or a destructive action: those are asked every time.
      const stickable = request.risk !== 'release' && request.risk !== 'destructive' && request.risk !== 'financial';
      if (stickable && standing.get(assignment.id)?.has(request.capability)) {
        return { approved: true, reason: `Allowed for the rest of this task (${request.capability}).`, approvalId: null };
      }
      // Nobody approves anything during an eval trial, so the tool is denied at
      // once rather than held until the run's deadline (P3b ruling 4).
      const mission = deps.missions.get(assignment.missionId);
      if (mission !== undefined && isTrialMission(mission)) {
        return { approved: false, reason: 'No one can approve tools during an eval trial.', approvalId: null };
      }
      const task = deps.tasks.get(assignment.taskId);
      const approval = deps.approvalFactory.createOrThrow({
        workspaceId: assignment.workspaceId,
        missionId: assignment.missionId,
        taskId: assignment.taskId,
        kind: request.risk === 'release' ? 'release' : 'action',
        risk: request.risk,
        title: `Allow ${request.toolName}?`,
        rationale: request.reason,
        effect: `${request.toolName} will act on ${request.resource ?? 'the current working directory'} `
          + `on behalf of ${task?.title ?? 'this task'}.`,
        evidence: [
          { kind: 'text', label: 'Capability', value: request.capability },
          { kind: 'text', label: 'Input', value: summarize(request.inputSummary, 400) },
          ...(request.resource === undefined
            ? []
            : [{ kind: 'text' as const, label: 'Resource', value: request.resource }]),
        ],
        ...(stickable
          ? {
            options: [
              { id: APPROVE_OPTION, label: 'Allow once', recommended: true },
              { id: APPROVE_FOR_TASK_OPTION, label: `Allow ${request.capability} for the rest of this task` },
              { id: REJECT_OPTION, label: 'Reject' },
            ],
          }
          : {}),
        // A worker blocked mid-call is holding a slot and a target, so its
        // question goes to the person who answers for the task, and up the
        // tree if they do not answer - never to an inbox nobody owns.
        ...(task === undefined || deps.address === undefined ? {} : deps.address(task, assignment.workspaceId)),
      });
      deps.approvals.create(approval);
      const actorId = deps.runs === undefined ? task?.assigneeId ?? null
        : runActorOf(deps.runs, { taskId: assignment.taskId, assignmentId: assignment.id }, task);
      deps.recorder.record({ ...scopeOf(assignment), actorId }, { type: 'approval.requested', approvalId: approval.id });
      deps.recorder.invalidate('approvals', assignment.missionId);

      let decided: ToolApprovalDecision;
      try {
        decided = await deps.waiter.wait(approval.id, signal);
      } finally {
        // Still PENDING means nobody decided: the run was aborted or ended
        // under the call, or the wait itself failed. The card is withdrawn
        // either way, or it would sit in the inbox - and escalate - asking
        // about a call no worker is making any more.
        if (deps.approvals.get(approval.id)?.status === 'PENDING') {
          withdrawApproval(deps, approval, 'The run ended before this was decided.');
        }
      }
      if (decided.approved && decided.selectedOptionId === APPROVE_FOR_TASK_OPTION) {
        const allowed = standing.get(assignment.id) ?? new Set<string>();
        allowed.add(request.capability);
        standing.set(assignment.id, allowed);
      }
      return decided;
    },
  };
}

/**
 * The bridge between "a tool is blocked on a human" and "the human answered".
 *
 * `ApprovalService.decide` settles whatever is waiting; an aborted run settles
 * as a refusal. Nothing here is persisted - the `Approval` row already is, and
 * a waiter that survived a restart would be waiting on a promise whose caller
 * is gone.
 */
export class ApprovalWaiter {
  readonly #waiting = new Map<ApprovalId, (decision: ToolApprovalDecision) => void>();

  wait(approvalId: ApprovalId, signal: AbortSignal): Promise<ToolApprovalDecision> {
    return new Promise<ToolApprovalDecision>((resolve) => {
      const settle = (decision: ToolApprovalDecision): void => {
        if (!this.#waiting.delete(approvalId)) return;
        resolve(decision);
      };
      this.#waiting.set(approvalId, settle);
      if (signal.aborted) {
        settle({ approved: false, reason: 'The run ended before the approval was decided.', approvalId });
        return;
      }
      signal.addEventListener(
        'abort',
        () => settle({ approved: false, reason: 'The run ended before the approval was decided.', approvalId }),
        { once: true },
      );
    });
  }

  /** No-op when nothing in this process was waiting on the approval. */
  settle(approval: Approval, approved: boolean): void {
    this.#waiting.get(approval.id)?.({
      approved,
      // The note *is* the answer when the card was a question, so it is carried
      // verbatim rather than summarised. The generic fallbacks only apply when
      // the person decided without writing anything.
      reason: approval.decisionNote
        ?? labelOf(approval) ?? (approved ? 'Approved.' : 'Rejected.'),
      approvalId: approval.id,
      selectedOptionId: approval.selectedOptionId,
    });
  }
}

/** The chosen option's label, for a decision made by clicking and nothing else. */
function labelOf(approval: Approval): string | undefined {
  return approval.options.find((o) => o.id === approval.selectedOptionId)?.label;
}

function scopeOf(assignment: WorkerAssignment): EventScope {
  return {
    workspaceId: assignment.workspaceId,
    missionId: assignment.missionId,
    taskId: assignment.taskId,
    roleId: assignment.roleId,
    runtimeProfileId: assignment.runtimeProfileId,
  };
}
