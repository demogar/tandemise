import type {
  ApprovalOption, ApprovalRepositoryPort, MissionTask, TaskRepositoryPort,
} from '@tandemise/domain';
import { CORE_CAPABILITIES, REJECT_OPTION } from '@tandemise/domain';
import type { ApprovalFactory } from '@tandemise/policy';
import { defineTool, type IntegrationTool, type ToolContext } from '@tandemise/integrations-core';
import type { Clock } from '@tandemise/shared';
import { summarize } from '@tandemise/shared';
import { z } from 'zod';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import type { ApprovalWaiter } from '../support/tool-policy.js';
import { MAX_PARKED_MS, type RunDeadlines } from '../engine/run-deadline.js';

export const ASK_HUMAN_TOOL = 'ask_human';

/** What the card offers when the worker asked an open question. */
const OPEN_ANSWER_OPTION: ApprovalOption = { id: 'answer', label: 'Send answer' };
const DECLINE_OPTION: ApprovalOption = {
  id: REJECT_OPTION,
  label: 'Decide without me',
  description: 'The worker continues on its own judgement and records the assumption it made.',
};

const askHumanInput = z.object({
  question: z
    .string()
    .trim()
    .min(3)
    .describe('The question, in one sentence, as you would ask a colleague.'),
  context: z
    .string()
    .trim()
    .optional()
    .describe(
      'What you already established, and why this is not yours to decide. '
      + 'Shown under the question so the person can answer without reading your transcript.',
    ),
  options: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        label: z.string().trim().min(1),
        description: z.string().trim().optional(),
      }),
    )
    .max(8)
    .optional()
    .describe(
      'The choices you see, when the question is a choice. Offer these whenever you can: '
      + 'picking from a list is a click, and an open question is a paragraph someone has to write.',
    ),
  recommended: z
    .string()
    .trim()
    .optional()
    .describe('The id of the option you would pick. Say which, and the reason belongs in `context`.'),
});

export interface AskHumanDeps {
  readonly approvals: ApprovalRepositoryPort;
  readonly approvalFactory: ApprovalFactory;
  readonly tasks: TaskRepositoryPort;
  readonly waiter: ApprovalWaiter;
  /** Stops the run's wall-time clock while the person thinks. */
  readonly deadlines: RunDeadlines;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
}

/**
 * Lets a worker ask the person supervising the mission a question, and wait for
 * the answer (MVP.md §18.3 `choice`).
 *
 * Without this a worker meeting a decision that is not its to make has two
 * moves: guess, or stop. Guessing produces work built on an assumption nobody
 * agreed to; stopping hands the task back to the user, which is the one thing
 * delegating it was meant to avoid. Neither is what a colleague would do, and
 * both were the only options this system offered.
 *
 * It is a built-in rather than an integration because there is no vendor behind
 * it and no version of this product where a workspace should be able to switch
 * it off. Every role holds `human.ask`, and it is classified `read`: a worker
 * must never need permission in order to request permission.
 *
 * The question becomes an ordinary `Approval`, so it arrives in the same inbox,
 * timeline and audit trail as everything else a person is asked. A second
 * notification surface for "questions", separate from "approvals", would be two
 * places to look and one of them would be missed.
 */
export function createAskHumanTool(deps: AskHumanDeps): IntegrationTool {
  const park = (task: MissionTask, question: string): void => {
    deps.tasks.update(task.id, {
      status: 'AWAITING_INPUT',
      statusReason: `Waiting for your answer: ${summarize(question, 160)}`,
    });
  };

  const unpark = (taskId: MissionTask['id']): void => {
    const current = deps.tasks.get(taskId);
    // Only this tool's own park is undone. If the task moved on - the run was
    // cancelled, the executor failed it - putting it back to RUNNING here would
    // resurrect a task nothing is driving.
    if (current?.status !== 'AWAITING_INPUT') return;
    deps.tasks.update(taskId, { status: 'RUNNING', statusReason: null });
  };

  return defineTool({
    name: ASK_HUMAN_TOOL,
    capability: CORE_CAPABILITIES.humanAsk,
    risk: 'read',
    description:
      'Ask the person supervising this mission a question and wait for their answer. '
      + 'Use it when a decision is genuinely theirs — which tool to use, which of two designs to '
      + 'build, a credential only they have — rather than guessing or giving up. '
      + 'Prefer offering `options`. They may decline, in which case decide yourself and say what '
      + 'you assumed.',
    inputSchema: askHumanInput,
    outputSchema: z.object({
      answered: z.boolean(),
      choice: z.string().nullable(),
      answer: z.string(),
    }),

    async execute(ctx: ToolContext, input): Promise<{
      output: { answered: boolean; choice: string | null; answer: string };
      summary: string;
    }> {
      const scope: EventScope = {
        workspaceId: ctx.assignment.workspaceId,
        missionId: ctx.assignment.missionId,
        taskId: ctx.assignment.taskId,
        roleId: ctx.assignment.roleId,
        ...(ctx.runId === null ? {} : { runId: ctx.runId }),
      };

      const chooseFrom = input.options ?? [];
      const approval = deps.approvalFactory.createOrThrow({
        workspaceId: ctx.assignment.workspaceId,
        missionId: ctx.assignment.missionId,
        taskId: ctx.assignment.taskId,
        kind: 'choice',
        risk: 'read',
        title: summarize(input.question, 160),
        rationale: input.context ?? 'A worker needs a decision that is not its to make.',
        effect: 'Your answer goes straight back to the worker, which is waiting on it and will carry on.',
        // The full question, because the title is cut at one line. The worker's
        // context is already the rationale, so it is not repeated here.
        evidence: [{ kind: 'text', label: 'Question', value: input.question }],
        // A single option is not a decision, and declining has to stay
        // available: a question you cannot refuse to answer is an interruption.
        options: [
          ...chooseFrom.map((o) => ({
            id: o.id,
            label: o.label,
            ...(o.description === undefined ? {} : { description: o.description }),
          })),
          ...(chooseFrom.length === 0 ? [OPEN_ANSWER_OPTION] : []),
          DECLINE_OPTION,
        ],
        recommendedOptionId: input.recommended ?? null,
      });
      deps.approvals.create(approval);

      const task = deps.tasks.get(ctx.assignment.taskId);
      // Parked, not running. The worker is alive but consuming nothing, and the
      // scheduler keeps the rest of the mission moving past it.
      if (task !== undefined) park(task, input.question);

      deps.recorder.record(scope, { type: 'approval.requested', approvalId: approval.id });
      deps.recorder.invalidate('approvals', ctx.assignment.missionId);
      deps.recorder.invalidate('tasks', ctx.assignment.missionId);

      // The clock stops for as long as the person takes, up to the run's park
      // allowance. Past it the worker is told so and continues on its own
      // judgement, rather than holding an idle process indefinitely.
      const allowanceMs = deps.deadlines.pause(ctx.assignmentId) ?? MAX_PARKED_MS;
      const unanswered = AbortSignal.timeout(Math.max(1, allowanceMs));

      try {
        const decision = await deps.waiter.wait(approval.id, AbortSignal.any([ctx.signal, unanswered]));
        const pending = deps.approvals.get(approval.id)?.status === 'PENDING';

        // Nobody decided: either the person did not get to it in time, or the
        // run ended underneath the question. Both close the card, because an
        // inbox item nothing is waiting for any more is a question the person
        // answers into the void.
        let answer = decision.reason;
        if (pending) {
          const timedOut = unanswered.aborted && !ctx.signal.aborted;
          answer = timedOut
            ? `No answer within ${hours(allowanceMs)}. Decide yourself, and record what you assumed.`
            : 'The run ended before this was answered.';
          deps.approvals.update(approval.id, {
            status: timedOut ? 'EXPIRED' : 'CANCELLED',
            decisionNote: answer,
            decidedAt: deps.clock.now(),
          });
          deps.recorder.invalidate('approvals', ctx.assignment.missionId);
        }

        const declined = pending || !decision.approved;
        return {
          output: {
            answered: !declined,
            choice: pending ? null : decision.selectedOptionId ?? null,
            answer,
          },
          summary: declined
            ? `Not answered: ${summarize(decision.reason, 120)}`
            : `Answered${decision.selectedOptionId === null || decision.selectedOptionId === undefined
              ? '' : ` '${decision.selectedOptionId}'`}: ${summarize(decision.reason, 120)}`,
        };
      } finally {
        // A runtime may ask two things at once. The task is only RUNNING again
        // once the last of them is answered.
        const stillParked = deps.deadlines.resume(ctx.assignmentId);
        if (!stillParked) unpark(ctx.assignment.taskId);
        deps.recorder.invalidate('tasks', ctx.assignment.missionId);
      }
    },
  });
}

function hours(ms: number): string {
  const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const h = Math.round(ms / 3_600_000);
  return h >= 1 ? plural(h, 'hour') : plural(Math.max(1, Math.round(ms / 60_000)), 'minute');
}
