import type {
  ApprovalRepositoryPort, Evaluation, EvaluationRepositoryPort, Finding, Mission,
  MissionRepositoryPort, MissionTask, RoleRepositoryPort, TaskRepositoryPort,
} from '@tandemise/domain';
import { blockingFindings, canTransition } from '@tandemise/domain';
import type { ApprovalFactory } from '@tandemise/policy';
import type { Clock, WorkspaceId } from '@tandemise/shared';
import type { RequestAddress } from './reviews.js';
import { ids, summarize } from '@tandemise/shared';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import { describeIssues, validateTaskGraph } from '../support/dag.js';

/**
 * At most this many fix/re-review cycles per source task before a human is
 * asked to intervene. Endless fix-review ping-pong is a real failure mode of
 * multi-agent systems and has to be bounded by something other than the user's
 * patience (APPLICATION_DESIGN.md §Loopback).
 */
export const MAX_REMEDIATION_CYCLES = 3;

/** The role that fixes what an evaluator found. */
const FIX_ROLE = 'development';

export type RemediationOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'planned'; readonly fixKey: string; readonly recheckKey: string; readonly findings: number }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * Turns findings into work (APPLICATION_DESIGN.md §Loopback).
 *
 * A review that produces a list nobody acts on is theatre. When an evaluator
 * reports blocking findings, this splices a real fix task into the DAG, a
 * re-evaluation after it, and re-points everything that was waiting on the
 * original evaluation so the mission cannot proceed on an unreviewed fix.
 *
 * Every mutation is followed by re-validating the whole graph. Inserting tasks
 * into a running DAG is the one place where a cycle can be introduced after
 * planning, and a cyclic mission never finishes - it just stops making progress
 * in a way that is hard to explain.
 */
export class RemediationPlanner {
  constructor(
    private readonly missions: MissionRepositoryPort,
    private readonly tasks: TaskRepositoryPort,
    private readonly evaluations: EvaluationRepositoryPort,
    private readonly roles: RoleRepositoryPort,
    private readonly approvals: ApprovalRepositoryPort,
    private readonly approvalFactory: ApprovalFactory,
    private readonly recorder: EventRecorder,
    private readonly clock: Clock,
    /** Who a card about a task is for and when it escalates; shared with every other card. */
    private readonly address: (task: MissionTask, workspaceId: WorkspaceId) => RequestAddress,
  ) {}

  plan(source: MissionTask, mission: Mission): RemediationOutcome {
    const evaluation = this.#latestEvaluation(source);
    if (evaluation === null) return { kind: 'none' };

    const blocking = blockingFindings(evaluation);
    if (blocking.length === 0) return { kind: 'none' };

    const scope: EventScope = {
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      taskId: source.id,
      roleId: source.roleId,
    };

    const existing = this.tasks.listByMission(mission.id);

    // Already acted on: a source task is remediated once, and the *re-check*
    // task it produced is a different task with its own findings.
    if (existing.some((t) => t.remediatesTaskId === source.id)) return { kind: 'none' };

    // The bound follows the chain, not the individual task. Without that, cycle
    // two would be counted against the re-check rather than the original, and
    // fix -> review -> fix could run forever three tasks at a time.
    const root = chainRoot(source, existing);
    const cycle = existing.filter((t) => t.key.startsWith('fix_') && chainRoot(t, existing) === root).length + 1;
    if (cycle > MAX_REMEDIATION_CYCLES) {
      return this.escalate(source, mission, blocking);
    }

    const fixKey = `fix_${source.key}_${cycle}`;
    const recheckKey = `${source.key}_recheck_${cycle}`;
    const template = this.#developmentTemplate(existing);

    const fix: MissionTask = {
      ...template,
      id: ids.task(),
      missionId: mission.id,
      key: fixKey,
      title: `Fix ${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'} from ${source.title}`,
      objective: fixObjective(source, evaluation, blocking),
      roleId: FIX_ROLE,
      dependsOn: [source.key],
      inputArtifacts: [
        ...template.inputArtifacts,
        ...source.expectedOutputs.map((type) => ({ type, required: true as const })),
      ],
      status: 'PENDING',
      statusReason: null,
      attempts: 0,
      // Spread from an existing development task, so without this it would inherit that task's round number.
      round: 1,
      // The flag is about the output being revised, not about the new round.
      needsAttention: false,
      remediatesTaskId: source.id,
      orderHint: source.orderHint + 1,
      createdAt: this.clock.now(),
      updatedAt: this.clock.now(),
      startedAt: null,
      finishedAt: null,
    };

    const recheck: MissionTask = {
      ...source,
      id: ids.task(),
      key: recheckKey,
      title: `Re-check ${source.title} (cycle ${cycle})`,
      objective: recheckObjective(source, blocking),
      dependsOn: [fixKey],
      status: 'PENDING',
      statusReason: null,
      attempts: 0,
      // Spread from the reviewed task, so without this it would inherit that task's round number.
      round: 1,
      // The flag is about the output being revised, not about the new round.
      needsAttention: false,
      remediatesTaskId: source.id,
      orderHint: source.orderHint + 2,
      createdAt: this.clock.now(),
      updatedAt: this.clock.now(),
      startedAt: null,
      finishedAt: null,
    };

    // Everything that was waiting on the evaluation now waits on the re-check,
    // so downstream work cannot start from an unreviewed fix.
    const repointed = existing
      .filter((t) => t.id !== source.id && t.dependsOn.includes(source.key))
      .map((t) => ({ ...t, dependsOn: t.dependsOn.map((d) => (d === source.key ? recheckKey : d)) }));

    const mutated = [
      ...existing.map((t) => repointed.find((r) => r.id === t.id) ?? t),
      fix,
      recheck,
    ];

    const validated = validateTaskGraph(mutated, this.roles.list(mission.workspaceId));
    if (!validated.ok) {
      const reason = `Remediation would produce an invalid plan: ${describeIssues(validated.error)}`;
      this.recorder.note(scope, reason, 'error');
      return { kind: 'rejected', reason };
    }

    this.tasks.add(fix);
    this.tasks.add(recheck);
    for (const task of repointed) this.tasks.update(task.id, { dependsOn: task.dependsOn });

    this.recorder.note(
      scope,
      `${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'} from ${source.key} became `
      + `'${fixKey}', followed by '${recheckKey}'. `
      + `${repointed.length} downstream task${repointed.length === 1 ? '' : 's'} now wait on the re-check.`,
    );
    this.recorder.invalidate('tasks', mission.id);
    return { kind: 'planned', fixKey, recheckKey, findings: blocking.length };
  }

  /**
   * Asks a person to step in when findings keep coming back: the fix-task chain
   * ran out of cycles, or the reviewed task already went through its AI-started
   * rounds (spec §5). Public because the review round path ends here too.
   */
  escalate(source: MissionTask, mission: Mission, blocking: readonly Finding[]): RemediationOutcome {
    const scope: EventScope = {
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      taskId: source.id,
      roleId: source.roleId,
    };
    // Worded for both paths: fix tasks and rounds of the reviewed task are each an attempt at the findings.
    const reason = `'${source.key}' still reports ${blocking.length} blocking finding(s) after `
      + `${MAX_REMEDIATION_CYCLES} attempts to address them. A human has to decide how to proceed.`;

    const alreadyAsked = this.approvals
      .list({ missionId: mission.id, statuses: ['PENDING'] })
      .some((a) => a.taskId === source.id && a.kind === 'intervention');

    if (!alreadyAsked) {
      const approval = this.approvalFactory.createOrThrow({
        workspaceId: mission.workspaceId,
        missionId: mission.id,
        taskId: source.id,
        kind: 'intervention',
        risk: 'read',
        title: `${source.title} is not converging`,
        rationale: reason,
        effect: 'Approving accepts the remaining findings and lets the mission continue. '
          + 'Rejecting leaves the mission blocked for you to change the plan or the goal.',
        evidence: blocking.slice(0, 10).map((f) => ({
          kind: 'text' as const,
          label: f.title,
          value: summarize(`${f.detail}${f.location === null ? '' : ` (${f.location})`}`, 400),
        })),
        options: [
          { id: 'approve', label: 'Accept the findings and continue' },
          { id: 'reject', label: 'Leave the mission blocked' },
        ],
        recommendedOptionId: null,
        // For whoever answers for the work that is not converging.
        ...this.address(source, mission.workspaceId),
      });
      this.approvals.create(approval);
      this.recorder.record(scope, { type: 'approval.requested', approvalId: approval.id });
      this.recorder.invalidate('approvals', mission.id);
    }

    if (canTransition(mission.status, 'BLOCKED')) {
      this.missions.update(mission.id, { status: 'BLOCKED', statusReason: reason });
      this.recorder.record(scope, { type: 'mission.status', from: mission.status, to: 'BLOCKED', reason });
    }
    this.recorder.invalidate('missions', mission.id);
    return { kind: 'blocked', reason };
  }

  #latestEvaluation(task: MissionTask): Evaluation | null {
    const all = [...this.evaluations.listEvaluations(task.id)]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return all[all.length - 1] ?? null;
  }

  /**
   * A fix task inherits its execution shape from whatever development task the
   * plan already contains: same isolation, same capabilities, same budget.
   * Inventing a policy here would produce a fix task that is permitted to do
   * less than the code it is fixing was written with.
   */
  #developmentTemplate(existing: readonly MissionTask[]): MissionTask {
    const development = existing.find((t) => t.roleId === FIX_ROLE);
    if (development !== undefined) return development;
    const fallback = existing[0];
    if (fallback === undefined) {
      throw new Error('Cannot plan remediation for a mission with no tasks.');
    }
    return {
      ...fallback,
      roleId: FIX_ROLE,
      expectedOutputs: ['ChangeSet'],
      completionGate: 'artifact.ChangeSet.exists',
      executionPolicy: { ...fallback.executionPolicy, isolation: 'worktree' },
    };
  }
}

/**
 * The task a remediation chain started from. Each fix and re-check points at
 * the task that produced its findings, so following `remediatesTaskId` upward
 * lands on the original evaluation.
 */
function chainRoot(task: MissionTask, all: readonly MissionTask[]): string {
  const byId = new Map(all.map((t) => [t.id, t]));
  let current = task;
  const seen = new Set<string>([current.id]);
  for (;;) {
    const parentId = current.remediatesTaskId;
    if (parentId === null || seen.has(parentId)) return current.id;
    const parent = byId.get(parentId);
    if (parent === undefined) return parentId;
    seen.add(parentId);
    current = parent;
  }
}

function fixObjective(
  source: MissionTask,
  evaluation: Evaluation,
  blocking: readonly Finding[],
): string {
  const list = blocking
    .map((f, i) => [
      `${i + 1}. ${f.title}`,
      f.location === null ? null : `   Location: ${f.location}`,
      f.detail.trim() === '' ? null : `   Detail: ${f.detail}`,
      f.suggestedFix === null ? null : `   Suggested fix: ${f.suggestedFix}`,
    ].filter((l): l is string => l !== null).join('\n'))
    .join('\n');

  return [
    `Fix every blocking finding that ${source.title} raised. These are quoted verbatim from the`,
    `evaluator's report (${evaluation.verdict}); do not reinterpret them.`,
    '',
    list,
    '',
    'Change only what is needed to resolve these findings. Do not take the opportunity to refactor',
    'elsewhere: a fix that is hard to re-review is a fix that costs another cycle. Add or update a',
    'test for each finding that can be covered by one, then run the repository checks.',
  ].join('\n');
}

function recheckObjective(source: MissionTask, blocking: readonly Finding[]): string {
  return [
    source.objective,
    '',
    'This is a re-check. The previous pass raised these blocking findings, which have now been',
    'addressed by a fix task:',
    ...blocking.map((f) => `- ${f.title}`),
    '',
    'Verify each one against the actual diff. A finding you cannot confirm as fixed stays blocking —',
    "the fix author's account of its own work is not evidence.",
  ].join('\n');
}
