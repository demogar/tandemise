import type {
  ApprovalRepositoryPort, Evaluation, EvaluationRepositoryPort, Finding, Mission,
  MissionRepositoryPort, MissionTask, RoleRepositoryPort, TaskRepositoryPort,
} from '@tandemise/domain';
import { blockingFindings, canTransition } from '@tandemise/domain';
import type { ApprovalFactory } from '@tandemise/policy';
import type { Clock } from '@tandemise/shared';
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

export type RevisionOutcome =
  | { readonly kind: 'planned'; readonly revisionKey: string; readonly round: number }
  | { readonly kind: 'rejected'; readonly reason: string };

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
      return this.#exhausted(source, mission, scope, blocking);
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
   * Turns a person's "not like this" into the next round of the same work.
   *
   * An evaluator's findings go to a developer and back to the evaluator. A
   * person rejecting output is a different loop: they *are* the reviewer, and
   * the role that made the thing is the one that should revise it - the
   * designer redoes the design, not a developer. So the revision is a copy of
   * the rejected task, with the feedback folded into its objective and its
   * previous output as an input, and it inherits the rejected task's approval
   * policy: the revision comes back to the same person for the same decision.
   *
   * There is no cycle bound here, unlike `plan`. Every round starts with a human
   * rejecting the previous one, so nothing can loop without a person choosing to
   * go round again - and "you may only ask for three revisions" is not a rule
   * anyone iterating on a design would accept.
   *
   * The rejected task is marked SKIPPED, with a reason naming its revision,
   * rather than left BLOCKED. Its output still exists and is what the revision
   * starts from; it simply no longer gates anything, because everything that
   * was waiting on it now waits on the revision.
   */
  planRevision(source: MissionTask, mission: Mission, feedback: string): RevisionOutcome {
    const scope: EventScope = {
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      taskId: source.id,
      roleId: source.roleId,
    };

    const existing = this.tasks.listByMission(mission.id);
    const rootId = chainRoot(source, existing);
    const root = existing.find((t) => t.id === rootId) ?? source;
    const round = existing.filter((t) => t.key.startsWith(`${root.key}_revision_`)).length + 1;
    const revisionKey = `${root.key}_revision_${round}`;

    const revision: MissionTask = {
      ...source,
      id: ids.task(),
      key: revisionKey,
      title: `${root.title} (revision ${round})`,
      objective: revisionObjective(root, source, this.#earlierFeedback(root, source, existing), feedback, round),
      dependsOn: [source.key],
      inputArtifacts: mergeRequirements(
        source.inputArtifacts,
        source.expectedOutputs.map((type) => ({ type, required: true as const })),
      ),
      status: 'PENDING',
      statusReason: null,
      attempts: 0,
      remediatesTaskId: source.id,
      orderHint: source.orderHint + 1,
      createdAt: this.clock.now(),
      updatedAt: this.clock.now(),
      startedAt: null,
      finishedAt: null,
    };

    const repointed = existing
      .filter((t) => t.id !== source.id && t.dependsOn.includes(source.key))
      .map((t) => ({ ...t, dependsOn: t.dependsOn.map((d) => (d === source.key ? revisionKey : d)) }));

    const superseded: MissionTask = {
      ...source,
      status: 'SKIPPED',
      statusReason: `Superseded by '${revisionKey}' after your feedback.`,
    };

    const mutated = [
      ...existing.map((t) => (t.id === source.id ? superseded : repointed.find((r) => r.id === t.id) ?? t)),
      revision,
    ];
    const validated = validateTaskGraph(mutated, this.roles.list(mission.workspaceId));
    if (!validated.ok) {
      const reason = `A revision would produce an invalid plan: ${describeIssues(validated.error)}`;
      this.recorder.note(scope, reason, 'error');
      return { kind: 'rejected', reason };
    }

    this.tasks.add(revision);
    for (const task of repointed) this.tasks.update(task.id, { dependsOn: task.dependsOn });
    this.tasks.update(source.id, {
      status: superseded.status,
      statusReason: superseded.statusReason,
      finishedAt: this.clock.now(),
    });
    this.recorder.record(scope, {
      type: 'task.status',
      from: source.status,
      to: 'SKIPPED',
      reason: superseded.statusReason ?? undefined,
    });

    this.recorder.note(
      scope,
      `Your feedback on '${source.key}' became '${revisionKey}'. `
      + `${repointed.length} downstream task${repointed.length === 1 ? '' : 's'} now wait on the revision.`,
    );
    this.recorder.invalidate('tasks', mission.id);
    return { kind: 'planned', revisionKey, round };
  }

  /**
   * What the person said about every earlier round of this work, oldest first.
   *
   * The rejected approvals already are the history, so it is read from them
   * rather than copied forward through objectives. Without it round two would be
   * briefed on round two's note alone, and the worker would be free to undo
   * what round one asked for - "make the buttons bigger" lost the moment
   * someone says "now move the total".
   */
  #earlierFeedback(root: MissionTask, source: MissionTask, existing: readonly MissionTask[]): readonly string[] {
    const chain = new Set(
      existing
        .filter((t) => t.id === root.id || t.key.startsWith(`${root.key}_revision_`))
        .filter((t) => t.id !== source.id)
        .map((t) => t.id),
    );
    return this.approvals
      .list({ missionId: root.missionId, statuses: ['REJECTED'] })
      .filter((a) => a.taskId !== null && chain.has(a.taskId))
      .filter((a) => (a.decisionNote ?? '').trim().length > 0)
      .sort((a, b) => (a.decidedAt ?? '').localeCompare(b.decidedAt ?? ''))
      .map((a) => (a.decisionNote ?? '').trim());
  }

  #exhausted(
    source: MissionTask,
    mission: Mission,
    scope: EventScope,
    blocking: readonly Finding[],
  ): RemediationOutcome {
    const reason = `'${source.key}' still reports ${blocking.length} blocking finding(s) after `
      + `${MAX_REMEDIATION_CYCLES} remediation cycles. A human has to decide how to proceed.`;

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

/** Union by artifact type; a requirement already present keeps its own `required`. */
function mergeRequirements(
  base: MissionTask['inputArtifacts'],
  extra: MissionTask['inputArtifacts'],
): MissionTask['inputArtifacts'] {
  const seen = new Set(base.map((r) => r.type));
  return [...base, ...extra.filter((r) => !seen.has(r.type))];
}

/**
 * The person's words are quoted, not paraphrased. They came from the user
 * supervising the mission - as trusted as the mission goal - and a summary
 * written by this system would be one more place for "make it feel lighter" to
 * turn into something they did not say.
 */
function revisionObjective(
  root: MissionTask,
  source: MissionTask,
  earlier: readonly string[],
  feedback: string,
  round: number,
): string {
  const quote = (text: string): string[] => text.trim().split('\n').map((line) => `> ${line}`);
  return [
    root.objective,
    '',
    `This is revision ${round}. The person supervising this mission reviewed the previous`,
    `output of '${source.key}' and asked for changes. Their feedback, verbatim:`,
    '',
    ...quote(feedback),
    ...(earlier.length === 0 ? [] : [
      '',
      'What they asked for in earlier rounds still stands. Do not undo it:',
      ...earlier.flatMap((note, i) => ['', `Round ${i + 1}:`, ...quote(note)]),
    ]),
    '',
    'Your previous output is available as an input artifact. Revise it - do not start over -',
    'and change what the feedback asks for without regressing anything else. If the feedback',
    'is ambiguous in a way that changes the result, ask with `ask_human` before building.',
    'State in your output what you changed in response to each point.',
  ].join('\n');
}
