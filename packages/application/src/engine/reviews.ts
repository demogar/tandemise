import type {
  Approval, ApprovalEvidence, ApprovalRepositoryPort, ArtifactRepositoryPort, CheckResult, GateFacts, GateOutcome,
  MemberRepositoryPort, Mission, MissionRepositoryPort, MissionTask, RoleRepositoryPort, RoleTemplate, RunRepositoryPort, StaffingReview,
  TaskRepositoryPort, Team, Workspace,
} from '@tandemise/domain';
import {
  APPROVE_OPTION, BASE_STAFFING, DEFAULT_ESCALATE_AFTER_MS, LOOKS_GOOD_OPTION, NEEDS_CHANGES_OPTION, REJECT_OPTION, REQUEST_CHANGES_OPTION, evaluateGate, gateDependencies, nextEscalation,
  indexTeam, isActiveMember, responsibleFor, reviewersFor, signOffLead,
} from '@tandemise/domain';
import type { ApprovalFactory } from '@tandemise/policy';
import type { Clock, Logger, WorkspaceId } from '@tandemise/shared';
import { errorMessage, summarize } from '@tandemise/shared';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import type { GateService, TaskMeasurements } from './gates.js';
import { waitingReason, type StaffingResolver } from './staffing-resolver.js';
import type { TaskAttemptOutcome } from './task-executor.js';

/** Evidence label carrying a blocking review's place in the pipeline, as `<n>/<total>`. */
export const REVIEW_EVIDENCE_LABEL = 'Review';
/** Evidence label marking the lead's sign-off that follows the last review. */
export const SIGN_OFF_EVIDENCE_LABEL = 'Sign-off';
export const POOL_ESCALATED_REASON = 'Escalated: nobody claimed it.';
/**
 * Evidence label carrying what the round measured about its own diff. Kept on
 * the card, and carried to every card after it, so a later review's `when`
 * reads the same value the first one did - across a restart too.
 */
export const FILES_CHANGED_EVIDENCE_LABEL = 'Files changed';
/** Why a review or sign-off was skipped when the only person who could give it did the work. */
export const AUTHOR_ONLY_REVIEWER_REASON = 'author is the only reviewer';

/**
 * The answers on a card that asks "do you accept this output?". Request changes
 * sits between the two because it is the usual "not yet": the same task goes
 * again as its next round, where a bare reject only stops it (P2 spec §6).
 */
const OUTPUT_REVIEW_OPTIONS = [
  { id: APPROVE_OPTION, label: 'Approve', recommended: true },
  { id: REQUEST_CHANGES_OPTION, label: 'Request changes' },
  { id: REJECT_OPTION, label: 'Reject without changes' },
] as const;

/** What `approvalPolicy.onCompletion` has always meant, expressed as a review. */
const COMPLETION_REVIEW: StaffingReview = { by: 'responsible', mode: 'blocking', when: 'always' };

type Settled = Extract<TaskAttemptOutcome, { kind: 'settled' }>;

export interface ReviewPipelineDeps {
  readonly approvals: ApprovalRepositoryPort;
  readonly approvalFactory: ApprovalFactory;
  readonly tasks: TaskRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly members: MemberRepositoryPort;
  readonly roles: RoleRepositoryPort;
  readonly artifacts: ArtifactRepositoryPort;
  /** To tell whether the run a card was raised in is still going. */
  readonly runs: RunRepositoryPort;
  readonly gates: GateService;
  readonly staffing: StaffingResolver;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
}

export interface RoundPassedInput {
  readonly task: MissionTask;
  readonly mission: Mission;
  readonly workspace: Workspace;
  readonly role: RoleTemplate | undefined;
  readonly gate: GateOutcome | null;
  readonly checks: readonly CheckResult[];
  readonly scope: EventScope;
  /** What only the attempt in hand measured, so `when` reads the same facts the gate did. */
  readonly measured?: TaskMeasurements;
}

/** Who a request about a task goes to, and when it moves up the team tree. */
export interface RequestAddress {
  readonly addressees: readonly string[];
  readonly escalateAfterMs: number | null;
}

/**
 * The people who look at finished work, in order, and what happens while
 * nobody answers (P0 spec, "Reviews at completion" and "Requests").
 *
 * Where a task is in its reviews is never held here or in a column: every
 * blocking card carries its place (`Review 2/3`, `Sign-off lead`) as evidence,
 * so a daemon started after a restart reads the pipeline back off the cards
 * alone and continues from the one just approved. The same card is also what
 * a person sees, so the position they are told and the position the engine
 * acts on cannot disagree.
 */
export class ReviewPipeline {
  constructor(private readonly deps: ReviewPipelineDeps) {}

  /**
   * Called when a round passes its gate. Returns the settled outcome for the
   * task without writing it: the executor's settle records the transition, so
   * a round ends in one status write and one event whichever way it went.
   */
  onRoundPassed(input: RoundPassedInput): Settled {
    const { task, mission, workspace, role, gate, checks, scope } = input;
    const reviews = effectiveReviews(task);
    if (reviews.length === 0) return { kind: 'settled', status: 'SUCCEEDED', reason: null };

    const team = this.#team(workspace.id);
    let facts: GateFacts | undefined;
    const evidence = this.#completionEvidence(task, gate, checks, input.measured ?? {});
    const advanced = { authorSkippedBlocking: false };
    const card = this.#advance({
      task, mission, role, team, reviews, from: 0, scope, evidence, advanced,
      facts: () => (facts ??= this.deps.gates.factsFor(task, input.measured)),
    });
    if (card !== null) return { kind: 'settled', status: 'AWAITING_APPROVAL', reason: card.title };
    // A person's blocking review that was theirs alone is skipped, but their
    // lead's sign-off is another person's look and still applies.
    const signOff = advanced.authorSkippedBlocking ? this.#signOffFor(task, mission, team, evidence, scope, 'self-review-skipped') : null;
    return signOff === null
      ? { kind: 'settled', status: 'SUCCEEDED', reason: null }
      : { kind: 'settled', status: 'AWAITING_APPROVAL', reason: signOff.title };
  }

  /**
   * Called by the approval service after an output approval is APPROVED: the
   * next review, the lead's sign-off, or success.
   *
   * A card without a pipeline marker predates reviews; approving it succeeds
   * the task exactly as it always did.
   */
  onReviewApproved(approval: Approval, actorId?: string): void {
    if (approval.taskId === null) return;
    const task = this.deps.tasks.get(approval.taskId);
    if (task === undefined || task.status !== 'AWAITING_APPROVAL') return;
    const mission = this.deps.missions.get(task.missionId);
    if (mission === undefined) return;
    const scope: EventScope = {
      workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, roleId: task.roleId,
      ...(actorId === undefined ? {} : { actorId }),
    };

    const position = positionOf(approval);
    if (position === null || position.kind === 'sign-off') {
      this.#succeed(task, scope);
      return;
    }

    const team = this.#team(mission.workspaceId);
    const role = this.deps.roles.get(task.roleId, mission.workspaceId);
    const evidence = approval.evidence.filter((e) => !isMarker(e));
    // `when` is read again now rather than remembered, so a review that became
    // relevant while the earlier one waited still happens. What only the round
    // measured - its diff size - is read back off the card it was filed with.
    const reviews = effectiveReviews(task);
    const measured = measuredFrom(approval.evidence);
    const next = this.#advance({
      task, mission, role, team, reviews, from: position.number, scope, evidence,
      advanced: { authorSkippedBlocking: false },
      facts: () => this.deps.gates.factsFor(task, measured),
    });
    if (next !== null) {
      this.#holdFor(task, next);
      return;
    }

    const signOff = this.#signOffRequested(task, approval) ? null : this.#signOffFor(task, mission, team, evidence, scope, 'approved');
    if (signOff !== null) {
      this.#holdFor(task, signOff);
      return;
    }
    this.#succeed(task, scope);
  }

  /**
   * The lead's sign-off card, when the responsible person's lead has
   * `both_sign_off`. Skipped, and said so, when that lead did the work.
   */
  #signOffFor(
    task: MissionTask, mission: Mission, team: Team, evidence: readonly ApprovalEvidence[], scope: EventScope,
    after: 'approved' | 'self-review-skipped',
  ): Approval | null {
    const responsible = this.#responsible(team, task);
    const lead = responsible === null ? null : signOffLead(team, responsible);
    if (lead === null || responsible === null) return null;
    const author = personAuthor(team, task);
    if (lead === author) {
      this.deps.recorder.record(scope, { type: 'review.skipped', taskId: task.id, when: 'sign-off', facts: {}, reason: AUTHOR_ONLY_REVIEWER_REASON });
      return null;
    }
    return this.#createSignOff(task, mission, team, after === 'approved' || author === null ? responsible : author, lead, evidence, scope, after);
  }

  /**
   * Who a start, intervention or question card about this task is for: the
   * responsible person, and when it escalates. Shared so every card about a
   * task climbs the same tree on the same clock.
   */
  addressFor(task: MissionTask | undefined, workspaceId: WorkspaceId): RequestAddress {
    const team = this.#team(workspaceId);
    if (task === undefined) return { addressees: team.owners.map((m) => m.id), escalateAfterMs: DEFAULT_ESCALATE_AFTER_MS };
    const responsible = this.#responsible(team, task);
    return { addressees: responsible === null ? [] : [responsible], escalateAfterMs: escalateAfter(task) };
  }

  /**
   * A worker's question: the person doing the step, when a person is doing it
   * and is still on the team, then the person who answers for it. An agent's
   * question goes to its owner, because that is who answers for an agent's work.
   */
  questionAddressFor(task: MissionTask | undefined, workspaceId: WorkspaceId): RequestAddress {
    const base = this.addressFor(task, workspaceId);
    const assignee = task?.assigneeId ?? null;
    if (assignee === null) return base;
    const team = this.#team(workspaceId);
    const person = isActiveMember(team, assignee) && team.byId.get(assignee)?.kind === 'person';
    return person ? { ...base, addressees: [...new Set([assignee, ...base.addressees])] } : base;
  }

  /**
   * One pass of escalation. Returns how many requests moved.
   *
   * Only PENDING approvals already due are read - an indexed range, not the
   * inbox - because this runs on every scheduler tick. Tasks waiting on a
   * person are the other half: a pool nobody claimed, and a step whose person
   * has since left the team.
   */
  sweepEscalations(nowMs: number): number {
    let moved = 0;
    const teams = new Map<string, Team>();
    const teamOf = (id: WorkspaceId): Team => {
      let team = teams.get(id);
      if (team === undefined) teams.set(id, (team = this.#team(id)));
      return team;
    };

    for (const approval of this.deps.approvals.dueForEscalation(new Date(nowMs).toISOString())) {
      try {
        if (this.#escalate(approval, teamOf(approval.workspaceId), nowMs)) moved++;
      } catch (e) {
        this.deps.log.warn('reviews.escalation_failed', { approvalId: approval.id, error: errorMessage(e) });
      }
    }

    for (const task of this.deps.tasks.listByStatus(['AWAITING_HUMAN'])) {
      if (task.executor !== 'human' || task.staffing == null) continue;
      try {
        if (this.#reResolveIfStale(task) || this.#escalatePool(task, nowMs)) moved++;
      } catch (e) {
        this.deps.log.warn('reviews.escalation_failed', { taskId: task.id, error: errorMessage(e) });
      }
    }
    return moved;
  }

  // ------------------------------------------------------------- the pipeline

  /**
   * Runs reviews from `from` on: skips those whose `when` does not hold, leaves
   * a check for each `after` one, and stops at the first blocking one, whose
   * card it returns. Null when nothing blocks.
   */
  #advance(ctx: AdvanceContext): Approval | null {
    const { task, mission, team, reviews, scope } = ctx;
    const responsible = this.#responsible(team, task);
    const author = personAuthor(team, task);
    for (let i = ctx.from; i < reviews.length; i++) {
      const review = reviews[i]!;
      if (review.when !== 'always') {
        const facts = ctx.facts();
        const outcome = evaluateGate(review.when, facts);
        // A fact nobody measured compares false against everything, which
        // would skip the review silently. A review is a safety net: when it
        // cannot tell whether it applies, it applies.
        const missingFacts = gateDependencies(review.when).filter((path) => facts[path] === undefined);
        if (!outcome.passed && missingFacts.length > 0) {
          this.deps.recorder.record(scope, { type: 'review.required', taskId: task.id, when: review.when, missingFacts });
        } else if (!outcome.passed) {
          this.deps.recorder.record(scope, { type: 'review.skipped', taskId: task.id, when: review.when, facts: outcome.facts });
          continue;
        }
      }
      const reviewers = responsible === null ? [] : reviewersFor(team, review, responsible);
      // Nobody reviews their own work: approving what you just did adds no oversight.
      const addressees = author === null ? reviewers : reviewers.filter((id) => id !== author);
      if (reviewers.length > 0 && addressees.length === 0) {
        this.deps.recorder.record(scope, { type: 'review.skipped', taskId: task.id, when: review.when, facts: {}, reason: AUTHOR_ONLY_REVIEWER_REASON });
        if (review.mode === 'blocking') ctx.advanced.authorSkippedBlocking = true;
        continue;
      }
      if (review.mode === 'after') {
        this.#createCheck(task, mission, ctx.role, addressees, ctx.evidence, scope);
        continue;
      }
      return this.#createReview(task, mission, ctx.role, addressees, [
        ...ctx.evidence,
        { kind: 'text', label: REVIEW_EVIDENCE_LABEL, value: `${i + 1}/${reviews.length}` },
      ], scope);
    }
    return null;
  }

  #createReview(
    task: MissionTask, mission: Mission, role: RoleTemplate | undefined, addressees: readonly string[],
    evidence: readonly ApprovalEvidence[], scope: EventScope,
  ): Approval {
    const release = task.expectedOutputs.includes('ReleaseCandidate');
    const roleName = role?.name ?? task.roleId;
    return this.#file(mission, this.deps.approvalFactory.createOrThrow({
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      taskId: task.id,
      kind: release ? 'release' : 'action',
      risk: release ? 'release' : 'write_reversible',
      title: `Approve the output of ${task.title}?`,
      rationale: task.approvalPolicy.reason
        ?? `${roleName} finished '${task.key}' and its output authorizes the work that follows.`,
      effect: 'Approving releases every task that depends on this one. Request changes sends it back to '
        + `${roleName} as its next round, with your note as the brief. Reject without changes leaves it blocked.`,
      options: OUTPUT_REVIEW_OPTIONS,
      recommendedOptionId: APPROVE_OPTION,
      evidence,
      addressees,
      escalateAfterMs: escalateAfter(task),
    }), scope);
  }

  /**
   * A look at work that has already moved on. It does not escalate: nothing
   * waits on it, and chasing someone up the tree for a look that blocks
   * nothing would teach people to ignore escalations that do matter.
   */
  #createCheck(
    task: MissionTask, mission: Mission, role: RoleTemplate | undefined, addressees: readonly string[],
    evidence: readonly ApprovalEvidence[], scope: EventScope,
  ): Approval {
    return this.#file(mission, this.deps.approvalFactory.createOrThrow({
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      taskId: task.id,
      kind: 'check',
      risk: 'read',
      title: `Check ${task.title} when you can`,
      rationale: `${role?.name ?? task.roleId} finished '${task.key}'. Nothing waits on this: the work has already moved on.`,
      effect: 'Looks good records that you checked it. Needs changes with a note is feedback: the task goes again as '
        + 'its next round when nothing used its output yet, and otherwise you choose what happens to the work that did.',
      evidence,
      options: [
        { id: LOOKS_GOOD_OPTION, label: 'Looks good', recommended: true },
        { id: NEEDS_CHANGES_OPTION, label: 'Needs changes' },
      ],
      recommendedOptionId: LOOKS_GOOD_OPTION,
      addressees,
    }), scope);
  }

  /**
   * `who` approved the work, or - after their own review was skipped - did it:
   * the card says which, so it never credits someone with an approval they did not give.
   */
  #createSignOff(
    task: MissionTask, mission: Mission, team: Team, who: string, lead: string,
    evidence: readonly ApprovalEvidence[], scope: EventScope, after: 'approved' | 'self-review-skipped',
  ): Approval {
    const name = (id: string): string => team.byId.get(id)?.name ?? 'someone';
    return this.#file(mission, this.deps.approvalFactory.createOrThrow({
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      taskId: task.id,
      kind: task.expectedOutputs.includes('ReleaseCandidate') ? 'release' : 'action',
      risk: task.expectedOutputs.includes('ReleaseCandidate') ? 'release' : 'write_reversible',
      title: `Approve the output of ${task.title}?`,
      rationale: after === 'approved'
        ? `${name(who)} approved '${task.key}'. As their lead, ${name(lead)} signs off on it too before it counts.`
        : `${name(who)} did '${task.key}' themselves. As their lead, ${name(lead)} signs off on it before it counts.`,
      effect: 'Approving releases every task that depends on this one. Request changes sends it back to '
        + `${this.deps.roles.get(task.roleId, mission.workspaceId)?.name ?? task.roleId} as its next round, with your note as the brief. `
        + 'Reject without changes leaves it blocked.',
      options: OUTPUT_REVIEW_OPTIONS,
      recommendedOptionId: APPROVE_OPTION,
      evidence: [...evidence, { kind: 'text', label: SIGN_OFF_EVIDENCE_LABEL, value: 'lead' }],
      addressees: [lead],
      escalateAfterMs: escalateAfter(task),
    }), scope);
  }

  #file(mission: Mission, approval: Approval, scope: EventScope): Approval {
    this.deps.approvals.create(approval);
    this.deps.recorder.record(scope, { type: 'approval.requested', approvalId: approval.id });
    this.deps.recorder.invalidate('approvals', mission.id);
    return approval;
  }

  #completionEvidence(
    task: MissionTask, gate: GateOutcome | null, checks: readonly CheckResult[], measured: TaskMeasurements,
  ): readonly ApprovalEvidence[] {
    // Only what is live: a tighten pass or a retry supersedes a draft, and a
    // reviewer pointed at the draft would review words that no longer stand.
    const all = this.deps.artifacts.listByTask(task.id);
    const superseded = new Set(all.map((a) => a.supersedes).filter((id) => id !== null));
    const outputs = all.filter((a) => !superseded.has(a.id));
    return [
      ...(measured.filesChanged === undefined
        ? []
        : [{ kind: 'text' as const, label: FILES_CHANGED_EVIDENCE_LABEL, value: String(measured.filesChanged) }]),
      ...(gate === null
        ? [{ kind: 'text' as const, label: 'Gate', value: 'This task declares no completion gate.' }]
        : [{ kind: 'check' as const, label: `Gate ${gate.passed ? 'passed' : 'failed'}`, value: gate.detail }]),
      ...checks.map((c) => ({ kind: 'check' as const, label: c.name, value: `${c.outcome} — ${summarize(c.detail, 200)}` })),
      ...outputs.map((a) => ({ kind: 'artifact' as const, label: a.type, value: a.id })),
    ];
  }

  /**
   * Whether this round already asked the lead. A sign-off is only ever created
   * straight after the last review is approved, so one filed since that review
   * was created belongs to this round; one from an earlier round does not.
   */
  #signOffRequested(task: MissionTask, lastReview: Approval): boolean {
    return this.deps.approvals
      .list({ missionId: task.missionId })
      .some((a) => a.taskId === task.id && a.createdAt >= lastReview.createdAt && positionOf(a)?.kind === 'sign-off');
  }

  #holdFor(task: MissionTask, card: Approval): void {
    if (task.statusReason === card.title) return;
    this.deps.tasks.update(task.id, { statusReason: card.title });
    this.deps.recorder.invalidate('tasks', task.missionId);
  }

  #succeed(task: MissionTask, scope: EventScope): void {
    this.deps.tasks.update(task.id, { status: 'SUCCEEDED', statusReason: null, finishedAt: this.deps.clock.now() });
    this.deps.recorder.record(scope, { type: 'task.status', from: task.status, to: 'SUCCEEDED' });
    this.deps.recorder.invalidate('tasks', task.missionId);
  }

  // --------------------------------------------------------------- escalation

  #escalate(approval: Approval, team: Team, nowMs: number): boolean {
    const task = approval.taskId === null ? undefined : this.deps.tasks.get(approval.taskId);
    const mission = approval.missionId === null ? undefined : this.deps.missions.get(approval.missionId);
    if (!this.#stillAwaited(approval, task, mission)) {
      this.deps.approvals.update(approval.id, { escalateAt: null });
      return false;
    }
    const root = task === undefined ? this.#planRoot(team, mission) : this.#responsible(team, task);
    const after = task === undefined ? DEFAULT_ESCALATE_AFTER_MS : escalateAfter(task);
    const addressees = approval.addressees ?? [];
    const next = root === null || after === null ? null : nextEscalation(team, root, addressees);

    if (next === null || after === null) {
      // The top of the tree already has it: it just waits, as every request
      // did before escalation existed.
      this.deps.approvals.update(approval.id, { escalateAt: null });
      return false;
    }
    const level = (approval.escalationLevel ?? 0) + 1;
    this.deps.approvals.update(approval.id, {
      addressees: [...addressees, next],
      escalationLevel: level,
      escalateAt: new Date(nowMs + after).toISOString(),
    });
    if (mission !== undefined) {
      this.deps.recorder.record(
        { workspaceId: mission.workspaceId, missionId: mission.id, taskId: approval.taskId },
        { type: 'approval.escalated', approvalId: approval.id, to: [next], level },
      );
    }
    this.deps.recorder.invalidate('approvals', approval.missionId ?? undefined);
    return true;
  }

  /**
   * Whether anything still waits on this card. Withdrawal normally closes a
   * card whose run ended, but a daemon that died mid-call leaves it PENDING;
   * escalating that would interrupt someone senior about a request nobody is
   * making. A card on a task that is no longer running or waiting is left to
   * sit, as are cards on a run that has finished. An intervention is the
   * exception: it is raised on a BLOCKED task (retries exhausted), or on a
   * task that succeeded while its mission is BLOCKED on the card (remediation
   * that is not converging). Either way something is blocked *on* it.
   */
  #stillAwaited(approval: Approval, task: MissionTask | undefined, mission: Mission | undefined): boolean {
    if (approval.taskId !== null) {
      if (task === undefined) return false;
      const waiting = task.status === 'RUNNING' || task.status.startsWith('AWAITING_')
        || (approval.kind === 'intervention' && (task.status === 'BLOCKED' || mission?.status === 'BLOCKED'));
      if (!waiting) return false;
    }
    if (approval.runId !== null) {
      const run = this.deps.runs.get(approval.runId);
      if (run === undefined || (run.status !== 'STARTING' && run.status !== 'RUNNING')) return false;
    }
    return true;
  }

  /** A plan climbs from whoever asked for the mission, or the first owner. */
  #planRoot(team: Team, mission: Mission | undefined): string | null {
    const creator = mission?.createdBy ?? null;
    if (creator !== null && isActiveMember(team, creator)) return creator;
    return team.owners[0]?.id ?? null;
  }

  /**
   * A step waiting on someone who has left is resolved again (spec, "Error
   * handling"). Resolution falls back to the owners when nobody staffed is
   * left, and a step now staffed to an active agent goes back to READY.
   */
  #reResolveIfStale(task: MissionTask): boolean {
    if (!this.deps.staffing.isStale(task)) return false;
    const patch = this.deps.staffing.snapshot(task);
    if (patch === null) return false;
    const status = patch.executor === 'agent' ? 'READY' : 'AWAITING_HUMAN';
    const reason = status === 'READY' ? null : waitingReason(this.deps.members, { roleId: task.roleId, ...patch });
    this.#retarget(task, { ...patch, status, statusReason: reason });
    return true;
  }

  /**
   * An unclaimed pool past its wait is opened to the owners, who always exist.
   * A pool only one person could claim is already theirs (resolveStaffing
   * assigns them), but it is still a pool: left unanswered, it opens to the
   * owners the same way, and the person keeps it until someone takes it.
   */
  #escalatePool(task: MissionTask, nowMs: number): boolean {
    const snapshot = task.staffing;
    if (snapshot == null) return false;
    const soleClaimant = snapshot.staffing.mode === 'pool' && task.assigneeId != null
      && snapshot.claimable.length === 1 && snapshot.claimable[0] === task.assigneeId;
    if (task.assigneeId != null && !soleClaimant) return false;
    const after = snapshot.staffing.escalateAfterMs;
    if (after === null || Date.parse(task.updatedAt) + after > nowMs) return false;
    const mission = this.deps.missions.get(task.missionId);
    if (mission === undefined) return false;
    const added = this.#team(mission.workspaceId).owners.map((m) => m.id as string).filter((id) => !snapshot.claimable.includes(id));
    if (added.length === 0) return false;
    this.#retarget(task, {
      staffing: { ...snapshot, claimable: [...snapshot.claimable, ...added], escalatedTo: [...(snapshot.escalatedTo ?? []), ...added] },
      statusReason: POOL_ESCALATED_REASON,
    });
    return true;
  }

  #retarget(task: MissionTask, patch: Partial<MissionTask>): void {
    const mission = this.deps.missions.get(task.missionId);
    const updated = this.deps.tasks.update(task.id, patch);
    if (mission !== undefined) {
      this.deps.recorder.record(
        { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, roleId: task.roleId },
        {
          type: 'task.status', from: task.status, to: updated.status,
          ...(updated.statusReason === null ? {} : { reason: updated.statusReason }),
        },
      );
    }
    this.deps.recorder.invalidate('tasks', task.missionId);
  }

  // ------------------------------------------------------------------ lookups

  /**
   * The person who answers for the task now. The recorded one while they are
   * still here; otherwise resolved again, which falls back to an owner - so a
   * review never goes to someone who left. Null only for a workspace with no
   * active owner, which has nobody to address at all.
   */
  #responsible(team: Team, task: MissionTask): string | null {
    const recorded = task.responsibleId ?? null;
    if (recorded !== null && isActiveMember(team, recorded) && team.byId.get(recorded)?.kind === 'person') return recorded;
    if (team.owners.length === 0) return null;
    return responsibleFor(team, task.staffing?.staffing ?? BASE_STAFFING, task.assigneeId ?? null);
  }

  #team(workspaceId: WorkspaceId): Team {
    return indexTeam(this.deps.members.listByWorkspace(workspaceId, { includeRemoved: true }));
  }
}

interface AdvanceContext {
  readonly task: MissionTask;
  readonly mission: Mission;
  readonly role: RoleTemplate | undefined;
  readonly team: Team;
  readonly reviews: readonly StaffingReview[];
  /** Index of the first review still to run. */
  readonly from: number;
  readonly evidence: readonly ApprovalEvidence[];
  readonly facts: () => GateFacts;
  readonly scope: EventScope;
  /** Written by `#advance`: whether a blocking review was skipped because its only reviewer did the work. */
  readonly advanced: { authorSkippedBlocking: boolean };
}

/**
 * The person whose work the round is, when a person did it: a human step's
 * assignee once it is completed. An agent's work has no person author - its
 * reviewers are people, and none of them wrote it.
 */
function personAuthor(team: Team, task: MissionTask): string | null {
  if (task.executor !== 'human' || task.assigneeId == null) return null;
  return team.byId.get(task.assigneeId)?.kind === 'person' ? task.assigneeId : null;
}

/** The task's reviews, or the one review `approvalPolicy.onCompletion` has always implied. */
export function effectiveReviews(task: MissionTask): readonly StaffingReview[] {
  const reviews = task.staffing?.staffing.reviews ?? [];
  if (reviews.length > 0) return reviews;
  return task.approvalPolicy.onCompletion ? [COMPLETION_REVIEW] : [];
}

/** Null means never. A task resolved before staffing existed waits the default. */
function escalateAfter(task: MissionTask): number | null {
  return task.staffing == null ? DEFAULT_ESCALATE_AFTER_MS : task.staffing.staffing.escalateAfterMs;
}

type Position = { readonly kind: 'review'; readonly number: number } | { readonly kind: 'sign-off' };

/** Where in the pipeline a card sits, read from its own evidence. */
export function positionOf(approval: Approval): Position | null {
  if (approval.evidence.some((e) => e.kind === 'text' && e.label === SIGN_OFF_EVIDENCE_LABEL)) return { kind: 'sign-off' };
  const marker = approval.evidence.find((e) => e.kind === 'text' && e.label === REVIEW_EVIDENCE_LABEL);
  const match = marker === undefined ? null : /^(\d+)\/(\d+)$/.exec(marker.value);
  return match === null ? null : { kind: 'review', number: Number(match[1]) };
}

/** What the round measured, as its first card recorded it. */
function measuredFrom(evidence: readonly ApprovalEvidence[]): TaskMeasurements {
  const recorded = evidence.find((e) => e.kind === 'text' && e.label === FILES_CHANGED_EVIDENCE_LABEL);
  const filesChanged = recorded === undefined ? NaN : Number(recorded.value);
  return Number.isInteger(filesChanged) && filesChanged >= 0 ? { filesChanged } : {};
}

function isMarker(e: ApprovalEvidence): boolean {
  return e.kind === 'text' && (e.label === REVIEW_EVIDENCE_LABEL || e.label === SIGN_OFF_EVIDENCE_LABEL);
}

