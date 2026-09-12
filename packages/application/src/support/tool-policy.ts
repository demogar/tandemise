import type {
  Approval, ApprovalRepositoryPort, AssignmentRepositoryPort, MissionRepositoryPort,
  TaskRepositoryPort, WorkerAssignment, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { DEFAULT_AUTONOMY } from '@tandemise/domain';
import type { ApprovalFactory, PolicyEngine } from '@tandemise/policy';
import type {
  ApprovalGate, ToolApprovalDecision, ToolApprovalRequest, ToolPolicyDecision, ToolPolicyGate,
  ToolPolicyRequest,
} from '@tandemise/integrations-core';
import type { ApprovalId, Logger } from '@tandemise/shared';
import { summarize } from '@tandemise/shared';
import type { EventRecorder, EventScope } from './event-recorder.js';

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
      });
      deps.approvals.create(approval);
      deps.recorder.record(scopeOf(assignment), { type: 'approval.requested', approvalId: approval.id });
      deps.recorder.invalidate('approvals', assignment.missionId);

      const decided = await deps.waiter.wait(approval.id, signal);
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
