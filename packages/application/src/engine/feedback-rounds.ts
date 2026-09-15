import type {
  Approval, ApprovalRepositoryPort, ArtifactManifest, ArtifactRepositoryPort, ArtifactStorePort, EvaluationRepositoryPort, EventRepositoryPort, FeedbackItem,
  FeedbackRepositoryPort, Finding, LoadedArtifact, MemberRepositoryPort, Mission, MissionRepositoryPort, MissionTask, RunInputRepositoryPort,
  RunRepositoryPort, TaskRepositoryPort, TaskStatus, UnitOfWork,
} from '@tandemise/domain';
import {
  DEFAULT_RETRY_POLICY, FEEDBACK_TEXT_MAX, REQUEST_CHANGES_OPTION, RUNTIME_ACTOR, SYSTEM_ACTOR, blockingFindings, canTransition,
  citedFeedbackIds, isDeclinedChange,
} from '@tandemise/domain';
import type { ArtifactId, Clock, TaskId } from '@tandemise/shared';
import { TandemiseError, asId, ids, summarize } from '@tandemise/shared';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import { versionLines } from '../support/artifact-versions.js';
import { LIVE_RUN_STATUSES, downstreamConsumers, reviewedTaskOf, type Consumer } from '../support/downstream.js';
import {
  CLOSED_MISSION_MESSAGE, feedbackEffectFor, missionTakesRounds, type BriefItem, type RoundBrief, type RoundContract,
} from '../support/feedback-rules.js';
import { isStartApproval } from '../support/approval-view.js';
import { upstreamTaskIds } from '../support/lineage.js';
import { runActorOf } from '../support/run-actor.js';
import { withdrawApproval } from '../support/withdraw.js';
import { withoutEscalation } from './staffing-resolver.js';
import { MAX_REMEDIATION_CYCLES } from './remediation.js';

/** The statuses a task may start its next round from: it has settled, one way or another. */
export const ROUND_START_STATUSES: readonly TaskStatus[] = ['SUCCEEDED', 'AWAITING_APPROVAL', 'FAILED', 'BLOCKED', 'CANCELLED', 'SKIPPED'];
/** A round's own attempt budget; see the plan's rulings. */
export const ROUND_ATTEMPTS = DEFAULT_RETRY_POLICY.maxAttempts;

export interface FeedbackRoundsDeps {
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly runs: RunRepositoryPort;
  readonly artifacts: ArtifactRepositoryPort;
  /** Where a round reads the previous output it asks the author to edit. */
  readonly artifactStore: ArtifactStorePort;
  readonly approvals: ApprovalRepositoryPort;
  /** A review's findings, which become feedback on the task it reviewed. */
  readonly evaluations: EvaluationRepositoryPort;
  readonly feedback: FeedbackRepositoryPort;
  readonly runInputs: RunInputRepositoryPort;
  readonly members: MemberRepositoryPort;
  /** Which upstream round redid a task, for the brief of the pass that follows. */
  readonly events: EventRepositoryPort;
  readonly unitOfWork: UnitOfWork;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  /** Lazy: the scheduler depends on the executor, which depends on this. */
  readonly cancelTask: (taskId: TaskId) => void;
}

export interface RecordFeedbackInput {
  readonly task: MissionTask;
  readonly text: string;
  readonly artifactId: ArtifactId | null;
  readonly authorId: string;
  readonly recordedBy: string;
  readonly status: 'open' | 'queued';
  readonly round: number | null;
}

export interface DownstreamImpact {
  readonly task: MissionTask;
  readonly consumers: readonly Consumer[];
  /** Version number of each consumer's `used` artifact along its chain. */
  readonly usedVersion: ReadonlyMap<string, number>;
  readonly defaultChoice: 'redo' | 'keep';
}

/** What an AI review's blocking findings led to (spec §5, "AI review findings"). */
export type ReviewRouting =
  /** No blocking findings, or no single reviewed task that can go again: today's fix-task flow decides. */
  | { readonly kind: 'none' }
  | { readonly kind: 'round'; readonly reviewedTaskId: TaskId; readonly round: number; readonly items: number; readonly begun: RoundBegun }
  /**
   * The reviewed task is already going again: the findings joined that round as
   * notes (queued for a running pass, attached otherwise) and the review waits
   * to be redone after it. No fix task: it would fix a version being replaced.
   */
  | { readonly kind: 'noted'; readonly reviewedTaskId: TaskId; readonly items: number; readonly begun: RoundBegun }
  /** The reviewed task already went through its AI-started rounds: a person has to step in. */
  | { readonly kind: 'exhausted'; readonly blocking: readonly Finding[] };

/** A round written but not yet acted on outside the database. */
export interface RoundBegun {
  readonly task: MissionTask;
  /** Dependents with a live pass, to stop once the outermost unit has committed. */
  readonly stop: readonly TaskId[];
}

export interface StartRoundInput {
  readonly task: MissionTask;
  readonly feedbackIds: readonly string[];
  /** `none` when nothing consumed the output (or the task never finished). */
  readonly downstream: 'redo' | 'keep' | 'none';
  /** Subset of the impact's consumers; all of them when omitted. */
  readonly redoTaskIds?: readonly string[];
  readonly actorId: string;
  /** A card being decided right now, which must not be withdrawn under its decision. */
  readonly keepCardId?: string;
  /**
   * Dependents to redo even though no record says they used the output: a
   * review found through the graph whose run recorded no inputs from it still
   * has to look at the new version. Consumers between the task and each of them
   * are redone too.
   */
  readonly alsoRedo?: readonly TaskId[];
}

/**
 * Feedback items and the rounds they start (spec §2, §3, §10).
 *
 * One component for recording a note, reading what a task's output fed, and
 * reopening the task as its next round, so the service, the executor and the
 * review pipeline all reopen tasks the same way. It depends on repositories
 * only, never on a service, which keeps the composition free of cycles; the
 * one thing it needs from the scheduler, cancelling a live run, is a lazy
 * callback.
 */
export class FeedbackRounds {
  constructor(private readonly deps: FeedbackRoundsDeps) {}

  record(input: RecordFeedbackInput): FeedbackItem {
    const { deps } = this;
    const now = deps.clock.now();
    const item = deps.feedback.create({
      id: ids.feedback(), taskId: input.task.id, artifactId: input.artifactId, authorId: input.authorId,
      recordedBy: input.recordedBy, text: input.text.trim(), attachments: [], status: input.status, round: input.round,
      createdAt: now, updatedAt: now,
    });
    deps.recorder.record(this.#scope(input.task, input.authorId), {
      type: 'feedback.given', feedbackId: item.id, status: item.status, excerpt: summarize(item.text, 140),
    });
    deps.recorder.invalidate('tasks', input.task.missionId);
    return item;
  }

  impactOf(task: MissionTask): DownstreamImpact {
    const { deps } = this;
    const artifacts = deps.artifacts.listByMission(task.missionId);
    const consumers = downstreamConsumers(task, {
      tasks: deps.tasks.listByMission(task.missionId),
      runs: deps.runs.listByMission(task.missionId),
      inputs: deps.runInputs.listByMission(task.missionId),
      artifacts,
    });
    const lines = versionLines(artifacts);
    return {
      task,
      consumers,
      usedVersion: new Map(consumers.map((c) => [c.task.id as string, lines.get(c.used.id)?.version ?? 1])),
      // Work still running on the old version is wasted if kept; finished work is the person's call.
      defaultChoice: consumers.some((c) => LIVE_RUN_STATUSES.includes(c.task.status)) ? 'redo' : 'keep',
    };
  }

  /** Starts the round and stops the dependents a Redo overtook; for a caller with no unit of its own around it. */
  startRound(input: StartRoundInput): MissionTask {
    const begun = this.beginRound(input);
    this.stopOvertaken(begun);
    return begun.task;
  }

  /**
   * Stops what a round overtook. Only after the outermost commit: an aborted
   * pass re-reads its row as it settles, and must find PENDING there, never the
   * status from before the round.
   */
  stopOvertaken(begun: RoundBegun): void {
    for (const id of begun.stop) this.deps.cancelTask(id);
  }

  /**
   * Writes the round without stopping anything, for a caller that makes it part
   * of a larger unit (deciding a card, recording the note): that caller commits
   * and then calls `stopOvertaken`.
   */
  beginRound(input: StartRoundInput): RoundBegun {
    const { deps } = this;
    const task = deps.tasks.get(input.task.id) ?? input.task;
    if (!ROUND_START_STATUSES.includes(task.status)) {
      throw new TandemiseError('PRECONDITION_FAILED', `A task in ${task.status} cannot start a round.`, {
        details: { taskId: task.id, status: task.status },
      });
    }
    const mission = deps.missions.get(task.missionId);
    if (mission === undefined) throw TandemiseError.notFound('Mission', task.missionId);
    // Every path that reopens a task comes through here, so none can start a round nothing will ever run.
    if (!missionTakesRounds(mission)) {
      throw new TandemiseError('PRECONDITION_FAILED', CLOSED_MISSION_MESSAGE, { details: { missionId: mission.id, status: mission.status } });
    }
    const items = deps.feedback.listByTask(task.id);
    const notOpen = input.feedbackIds.filter((id) => !items.some((i) => i.id === id && i.status === 'open'));
    if (notOpen.length > 0) {
      // Read by a person, so the notes are counted, not listed by id; the ids are in the details.
      const message = notOpen.length === 1 && input.feedbackIds.length === 1
        ? `That note is no longer open on '${task.key}'.`
        : `${notOpen.length} of these notes are no longer open on '${task.key}'.`;
      throw TandemiseError.validation(message, { feedbackIds: notOpen, taskId: task.id });
    }
    const { consumers } = this.impactOf(task);
    if (input.downstream === 'none' && consumers.length > 0) {
      throw TandemiseError.validation(
        `Work already used the output of '${task.key}': choose whether to redo or keep it.`,
        { taskId: task.id, consumers: consumers.map((c) => c.task.id) },
      );
    }
    const all = deps.tasks.listByMission(task.missionId);
    const redone = [...(input.downstream === 'redo' ? redoSet(task, consumers, input.redoTaskIds, all) : [])];
    if (input.alsoRedo !== undefined && input.alsoRedo.length > 0) {
      for (const id of input.alsoRedo) {
        const extra = all.find((t) => t.id === id);
        if (extra === undefined || !upstreamTaskIds(extra, all).has(task.id)) {
          throw TandemiseError.validation(`${extra === undefined ? 'That task' : `'${extra.key}'`} does not depend on '${task.key}'.`, { taskId: id });
        }
        const upstream = upstreamTaskIds(extra, all);
        for (const dependent of [...consumers.filter((c) => upstream.has(c.task.id)).map((c) => c.task), extra]) {
          if (!redone.some((t) => t.id === dependent.id)) redone.push(dependent);
        }
      }
    }
    // Several items given before a round starts all go into that round (spec §2).
    const joining = items.filter((i) => i.status === 'open');
    const round = (task.round ?? 1) + 1;
    // Read on the card and in the drawer, where naming the one person who uses
    // the app reads as a stranger; who asked is the round's event actor, which
    // the timeline shows as "You".
    const reason = `Round ${round}: changes requested`;
    const scope = this.#scope(task, input.actorId);

    // One unit, so a failure part-way never leaves a round started with its
    // dependents still on the old version, or reset with no round to wait for.
    // Its events reach subscribers only once it has committed.
    const stop = deps.recorder.deferred(() => deps.unitOfWork.transaction(() => {
      for (const item of joining) deps.feedback.update(item.id, { status: 'in_round', round });
      deps.tasks.update(task.id, {
        round, status: 'READY', statusReason: reason, needsAttention: false, finishedAt: null,
        // The request is the brief now; a stale gate measurement would frame it as a failure.
        retryFeedback: null,
        retryPolicy: { ...task.retryPolicy, maxAttempts: task.attempts + ROUND_ATTEMPTS },
        ...(task.staffing?.escalatedTo === undefined ? {} : { staffing: withoutEscalation(task.staffing) }),
      });
      for (const card of deps.approvals.pendingForTask(task.id)) {
        if (card.id !== input.keepCardId) withdrawApproval(deps, card, `Superseded by round ${round} of '${task.key}'.`);
      }
      deps.recorder.record(scope, { type: 'task.status', from: task.status, to: 'READY', reason });
      deps.recorder.record(scope, {
        type: 'task.round_started', round, feedbackIds: joining.map((i) => i.id), downstream: input.downstream, redone: redone.map((t) => t.key),
      });
      const live = redone.filter((dependent) => this.#redo(dependent, task, round));
      this.#holdReady(task, `Waiting for round ${round} of '${task.key}'.`);
      this.#revive(mission, `'${task.key}' started round ${round}.`);
      return live;
    }));
    deps.recorder.invalidate('tasks', mission.id);
    deps.recorder.invalidate('approvals', mission.id);
    return { task: deps.tasks.get(task.id)!, stop: stop.map((dependent) => dependent.id) };
  }

  /**
   * Closes an output card as "Request changes": the note is on the card, and
   * the round carries it. Call it with the round start in one unit and pass
   * the card as `keepCardId`, so the round does not withdraw it under its own
   * decision.
   */
  decideReviewCard(card: Approval, input: { readonly actorId: string; readonly recordedBy: string; readonly note: string }): Approval {
    const { deps } = this;
    const decided = deps.approvals.update(card.id, {
      status: 'REJECTED', selectedOptionId: REQUEST_CHANGES_OPTION, decisionNote: input.note,
      decidedBy: input.actorId, recordedBy: input.recordedBy, decidedAt: deps.clock.now(), escalateAt: null,
    });
    if (card.missionId !== null) {
      deps.recorder.record(
        { workspaceId: card.workspaceId, missionId: card.missionId, taskId: card.taskId, actorId: input.actorId },
        { type: 'approval.resolved', approvalId: card.id, status: 'REJECTED', option: REQUEST_CHANGES_OPTION },
      );
    }
    deps.recorder.invalidate('approvals', card.missionId ?? undefined);
    return decided;
  }

  /**
   * A review asks the author to change their work, so its blocking findings
   * become feedback on the task it reviewed, and that task goes again as its
   * next round (spec §5, §10). The review is redone after it without asking:
   * the reviewer is the one who asked. Bounded like the fix-task chain it
   * replaces, because an agent reviewer and an agent author can disagree forever.
   */
  fromReviewFindings(review: MissionTask, mission: Mission): ReviewRouting {
    const { deps } = this;
    const evaluation = [...deps.evaluations.listEvaluations(review.id)].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    const blocking = evaluation === undefined ? [] : blockingFindings(evaluation);
    if (evaluation === undefined || blocking.length === 0) return { kind: 'none' };
    const reviewed = reviewedTaskOf(review, deps.tasks.listByMission(mission.id), deps.artifacts.listByMission(mission.id));
    if (reviewed === null) return { kind: 'none' };
    // The reviewer's agent member wrote the findings; an unstaffed run is the runtime's.
    const author = runActorOf(deps.runs, { runId: evaluation.runId, taskId: review.id }, review) ?? RUNTIME_ACTOR;
    const note = (task: MissionTask, status: 'open' | 'queued', round: number | null) => blocking.map((f) => this.record({
      task, artifactId: null, authorId: author, recordedBy: SYSTEM_ACTOR, status, round, text: summarize(findingText(f), FEEDBACK_TEXT_MAX),
    }));

    if (!ROUND_START_STATUSES.includes(reviewed.status)) {
      // Already going again (a person started its round while the review ran):
      // the findings join that round the way any note would, and the review
      // is redone once it lands, since it looked at the version being replaced.
      const effect = feedbackEffectFor(reviewed, deps.approvals.pendingForTask(reviewed.id), deps.runs);
      const round = reviewed.round ?? 1;
      const { items, stop } = deps.recorder.deferred(() => deps.unitOfWork.transaction(() => {
        const recorded = note(reviewed, effect.kind === 'queue' ? 'queued' : 'open', round);
        const live = this.#redo(review, reviewed, round);
        this.#holdReady(review, `Waiting for '${reviewed.key}' round ${round}.`);
        return { items: recorded, stop: live ? [review.id] : [] };
      }));
      deps.recorder.invalidate('tasks', mission.id);
      return { kind: 'noted', reviewedTaskId: reviewed.id, items: items.length, begun: { task: deps.tasks.get(reviewed.id) ?? reviewed, stop } };
    }

    // Only a round this would start counts against the cap; notes on a round already under way start nothing.
    if (this.#aiRounds(reviewed) >= MAX_REMEDIATION_CYCLES) return { kind: 'exhausted', blocking };

    // One unit: findings recorded for a round that fails to start would sit open with nobody to start it.
    // The review is always redone, whether or not its run recorded what it read from the reviewed task.
    // Nothing is stopped here: the caller stops what the round overtook once it has committed.
    const { items, begun } = deps.recorder.deferred(() => deps.unitOfWork.transaction(() => {
      const recorded = note(reviewed, 'open', null);
      return {
        items: recorded,
        begun: this.beginRound({ task: reviewed, feedbackIds: recorded.map((i) => i.id), downstream: 'redo', actorId: author, alsoRedo: [review.id] }),
      };
    }));
    return { kind: 'round', reviewedTaskId: reviewed.id, round: begun.task.round ?? 2, items: items.length, begun };
  }

  /**
   * Rounds an agent started, for the cap (plan ruling 14): distinct rounds that
   * hold any note from an agent or the runtime. A person's note swept into such
   * a round does not make it theirs, and a finding added to a person's round is
   * still an automated attempt at the findings, so both count.
   */
  #aiRounds(task: MissionTask): number {
    return new Set(
      this.deps.feedback.listByTask(task.id).filter((i) => i.round !== null && this.#isAgent(i.authorId)).map((i) => i.round),
    ).size;
  }


  /** A running pass that ended before it read a queued note leaves it stranded: it becomes open. Returns how many moved. */
  releaseStranded(): number {
    let moved = 0;
    for (const item of this.deps.feedback.listByStatus(['queued'])) {
      const task = this.deps.tasks.get(item.taskId);
      // Still running: the pass will read the note when it ends.
      if (task !== undefined && LIVE_RUN_STATUSES.includes(task.status)) continue;
      this.deps.feedback.update(item.id, { status: 'open', round: null });
      if (task !== undefined) {
        // Otherwise the note would change state with nothing on the timeline to say why.
        this.deps.recorder.note(
          this.#scope(task, SYSTEM_ACTOR),
          `A note arrived as '${task.key}' was finishing its pass, so it waits as an open note: "${summarize(item.text, 140)}"`,
        );
        this.deps.recorder.invalidate('tasks', task.missionId);
      }
      moved++;
    }
    return moved;
  }

  /**
   * Promotes the task's open notes into its current round and builds the brief;
   * null when the attempt carries no feedback. Open notes join because a pass
   * about to run is the round that reads them (spec §2: notes given before a
   * round starts all go into it).
   */
  async openRound(task: MissionTask): Promise<RoundBrief | null> {
    const { deps } = this;
    const round = task.round ?? 1;
    for (const item of deps.feedback.listByTask(task.id)) {
      if (item.status === 'open') deps.feedback.update(item.id, { status: 'in_round', round });
    }
    const current = deps.feedback.listByTask(task.id);
    const toAddress = current.filter((i) => i.status === 'in_round');
    // A later round always has a brief, even one nobody left a note for: it is still an edit of the last output.
    if (toAddress.length === 0 && round === 1) return null;
    // This task's own newest output per type. Supersession is not consulted: another
    // task's artifact (a fix task's ChangeSet) can supersede this one's, and this
    // task's next version then supersedes that, which would hide it or list it twice.
    // In round 1 this is only ever an earlier attempt's output, which a retry edits too.
    const newest = new Map<string, ArtifactManifest>();
    for (const manifest of deps.artifacts.listByTask(task.id)) {
      const known = newest.get(manifest.type);
      if (known === undefined || manifest.createdAt > known.createdAt) newest.set(manifest.type, manifest);
    }
    const previous: LoadedArtifact[] = [];
    for (const manifest of newest.values()) {
      try {
        previous.push(await deps.artifactStore.read(manifest.id));
      } catch {
        // An unreadable draft is left out; the brief still names the notes.
      }
    }
    const toItem = (i: FeedbackItem): BriefItem => ({
      id: i.id, authorName: this.#name(i.authorId), text: i.text, round: i.round,
      artifactType: i.artifactId === null ? null : deps.artifacts.get(i.artifactId)?.type ?? null,
    });
    return {
      round, previous,
      toAddress: toAddress.map(toItem),
      // This round's own answered notes too: a task redone within its round must not undo them either.
      earlier: current.filter((i) => i.status === 'addressed' && (i.round ?? 0) <= round).map(toItem),
      ...(toAddress.length === 0 ? { redoneAfter: this.#redoneAfter(task) } : {}),
    };
  }

  /**
   * The upstream round that last redid this task, when no run of the task has
   * started since: that is why a later round goes again with nothing owed.
   */
  #redoneAfter(task: MissionTask): { readonly key: string; readonly round: number } | null {
    const { deps } = this;
    const lastRun = [...deps.runs.listByTask(task.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const redo = deps.events.listByMission(task.missionId, { semanticOnly: true })
      .filter((e) => e.body.type === 'task.round_started' && e.body.redone.includes(task.key))
      .at(-1);
    if (redo === undefined || redo.body.type !== 'task.round_started' || redo.taskId === null) return null;
    if (lastRun !== undefined && lastRun.startedAt >= redo.createdAt) return null;
    const upstream = deps.tasks.get(redo.taskId);
    return upstream === undefined ? null : { key: upstream.key, round: redo.body.round };
  }

  roundContract(task: MissionTask, brief: RoundBrief): RoundContract {
    return {
      round: brief.round,
      required: brief.toAddress.map((i) => ({ id: i.id, artifactType: i.artifactType })),
      known: new Set(this.deps.feedback.listByTask(task.id).map((i) => i.id)),
      primaryType: task.expectedOutputs[0] ?? 'Evidence',
    };
  }

  /** Queued → in_round in the current round; returns what was delivered. */
  promoteQueued(task: MissionTask): readonly FeedbackItem[] {
    const round = task.round ?? 1;
    return this.deps.feedback.listByTask(task.id)
      .filter((i) => i.status === 'queued')
      .map((i) => this.deps.feedback.update(i.id, { status: 'in_round', round }));
  }

  /** A delivery pass the daemon interrupted hands its notes back. */
  requeue(items: readonly FeedbackItem[]): void {
    for (const item of items) {
      if (this.deps.feedback.get(item.id)?.status === 'in_round') this.deps.feedback.update(item.id, { status: 'queued' });
    }
  }

  hasQueued(taskId: TaskId): boolean {
    return this.deps.feedback.listByTask(taskId).some((i) => i.status === 'queued');
  }

  /**
   * Cited notes become addressed; with round > 1, consumers of the old version
   * that were kept get needsAttention. Called for every passed attempt, so in a
   * round > 1 a retry that passes flags kept consumers again, with the version
   * that is out now; flagging is idempotent on the task and only repeats the note.
   */
  onRoundLanded(task: MissionTask, manifests: readonly ArtifactManifest[], scope: EventScope): void {
    const { deps } = this;
    const round = task.round ?? 1;
    // A note counts as declined only when every entry citing it declines it.
    const declined = new Map<string, boolean>();
    for (const manifest of manifests) {
      for (const change of manifest.handoff?.changed ?? []) {
        const declines = isDeclinedChange(change.what);
        for (const id of citedFeedbackIds({ changed: [change] })) declined.set(id, (declined.get(id) ?? true) && declines);
      }
    }
    for (const item of deps.feedback.listByTask(task.id)) {
      if (item.status !== 'in_round' || !declined.has(item.id)) continue;
      deps.feedback.update(item.id, { status: 'addressed', round });
      deps.recorder.record(scope, { type: 'feedback.addressed', feedbackId: item.id, round, declined: declined.get(item.id)! });
    }
    if (round > 1) this.#flagKeptConsumers(task, scope);
    deps.recorder.invalidate('tasks', task.missionId);
  }

  /** A person cannot cite ids: completing addresses every open or in-round note in the current round. */
  onPersonCompleted(task: MissionTask, scope: EventScope): void {
    const round = task.round ?? 1;
    for (const item of this.deps.feedback.listByTask(task.id)) {
      if (item.status !== 'open' && item.status !== 'in_round') continue;
      this.deps.feedback.update(item.id, { status: 'addressed', round });
      this.deps.recorder.record(scope, { type: 'feedback.addressed', feedbackId: item.id, round, declined: false });
    }
    if (round > 1) this.#flagKeptConsumers(task, scope);
    this.deps.recorder.invalidate('tasks', task.missionId);
  }

  /**
   * Spec §3 Keep: whoever still stands on an older version is told a newer one
   * is out. A redone dependent is PENDING or running again and is not flagged.
   */
  #flagKeptConsumers(task: MissionTask, scope: EventScope): void {
    const { deps } = this;
    const artifacts = deps.artifacts.listByMission(task.missionId);
    const lines = versionLines(artifacts);
    const latest = Math.max(0, ...artifacts.filter((a) => a.taskId === task.id).map((a) => lines.get(a.id)?.version ?? 1));
    const impact = this.impactOf(task);
    for (const consumer of impact.consumers) {
      if (consumer.used.taskId !== task.id || lines.get(consumer.used.id)?.supersededBy === null) continue;
      if (consumer.task.status === 'PENDING' || consumer.task.status === 'READY' || LIVE_RUN_STATUSES.includes(consumer.task.status)) continue;
      const note = `Built against ${task.title} v${impact.usedVersion.get(consumer.task.id) ?? 1}; v${latest} is out.`;
      deps.tasks.update(consumer.task.id, { needsAttention: true });
      // The engine noticed this, not the agent whose round landed, and nobody
      // asked the consumer for changes: it stands on an older version. Credited
      // to Tandemise/system, not the consumer's role, so the timeline never
      // reads as if that role reported it.
      deps.recorder.record(
        { ...scope, taskId: consumer.task.id, roleId: null, actorId: SYSTEM_ACTOR },
        { type: 'task.attention', taskId: consumer.task.id, note, kind: 'stale_input', upstream: task.title },
      );
      deps.recorder.invalidate('tasks', task.missionId);
    }
  }

  /**
   * Spec §3 Redo: send it back to PENDING and withdraw its cards; staffing
   * resolves again at READY. Finished dependents are reset too, unlike a
   * mission-level hold, because Redo is the person's explicit choice (spec
   * §10). Returns whether a live pass must be stopped once this commits.
   */
  #redo(dependent: MissionTask, source: MissionTask, round: number): boolean {
    const { deps } = this;
    const current = deps.tasks.get(dependent.id) ?? dependent;
    const reason = `Redone after ${source.key} round ${round}`;
    deps.tasks.update(current.id, {
      status: 'PENDING', statusReason: reason, finishedAt: null, needsAttention: false, retryFeedback: null,
      retryPolicy: { ...current.retryPolicy, maxAttempts: current.attempts + ROUND_ATTEMPTS },
    });
    for (const card of deps.approvals.pendingForTask(current.id)) withdrawApproval(deps, card, reason);
    deps.recorder.record(this.#scope(current, SYSTEM_ACTOR), { type: 'task.status', from: current.status, to: 'PENDING', reason });
    return LIVE_RUN_STATUSES.includes(current.status);
  }

  /**
   * Downstream work that has consumed nothing is not in the dialog, because no
   * run of it recorded an input: a READY task (it never ran, or waits to retry),
   * a person's step not done yet, and a task still asking to start. Left as it
   * is, each would run or be completed on the old version, so it waits for the
   * round; a start card is withdrawn and asked again once the work is ready.
   *
   * Only work with a dependency that is no longer done is held. Work whose
   * dependencies all still stand (after a consumer that was kept) would be
   * promoted straight back by the scheduler, so holding it only adds noise.
   * Repeated until nothing moves, since a held task unsettles its own dependents.
   */
  #holdReady(task: MissionTask, reason: string): void {
    const { deps } = this;
    for (let moved = true; moved;) {
      moved = false;
      const all = deps.tasks.listByMission(task.missionId);
      const byKey = new Map(all.map((t) => [t.key, t]));
      for (const t of all) {
        if (!upstreamTaskIds(t, all).has(task.id)) continue;
        const startCards = t.status === 'AWAITING_APPROVAL'
          ? deps.approvals.pendingForTask(t.id).filter((a) => a.kind === 'action' && isStartApproval(a, t, deps.runs))
          : [];
        const asking = startCards.length > 0 && startCards.length === deps.approvals.pendingForTask(t.id).length;
        if (t.status !== 'READY' && t.status !== 'AWAITING_HUMAN' && !asking) continue;
        const waiting = t.dependsOn.some((key) => {
          const dependency = byKey.get(key);
          return dependency !== undefined && dependency.status !== 'SUCCEEDED' && dependency.status !== 'SKIPPED';
        });
        if (!waiting) continue;
        deps.tasks.update(t.id, { status: 'PENDING', statusReason: reason });
        for (const card of startCards) withdrawApproval(deps, card, reason);
        deps.recorder.record(this.#scope(t, SYSTEM_ACTOR), { type: 'task.status', from: t.status, to: 'PENDING', reason });
        moved = true;
      }
    }
  }

  /** A mission that had stopped has work again, so the scheduler must pick it up. */
  #revive(mission: Mission, reason: string): void {
    if (mission.status !== 'BLOCKED' && mission.status !== 'COMPLETE' && mission.status !== 'FAILED') return;
    if (!canTransition(mission.status, 'EXECUTING')) return;
    this.deps.missions.update(mission.id, { status: 'EXECUTING', statusReason: reason });
    this.deps.recorder.record(
      { workspaceId: mission.workspaceId, missionId: mission.id },
      { type: 'mission.status', from: mission.status, to: 'EXECUTING', reason },
    );
    this.deps.recorder.invalidate('missions', mission.id);
  }

  #isAgent(id: string): boolean {
    return id === RUNTIME_ACTOR || this.deps.members.get(asId<'MemberId'>(id))?.kind === 'agent';
  }

  #name(memberId: string): string {
    if (memberId === RUNTIME_ACTOR) return 'Runtime';
    return this.deps.members.get(asId<'MemberId'>(memberId))?.name ?? 'Someone';
  }

  #scope(task: MissionTask, actorId: string): EventScope {
    const mission = this.deps.missions.get(task.missionId)!;
    return { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, roleId: task.roleId, actorId };
  }
}

/** A finding as one note: what is wrong, where, why, and the reviewer's suggestion when there is one. */
function findingText(f: Finding): string {
  const detail = f.detail.trim();
  return `${f.title}${f.location ? ` (${f.location})` : ''}${detail ? `: ${detail}` : ''}${f.suggestedFix ? ` Suggested fix: ${f.suggestedFix}` : ''}`;
}

/**
 * The dependents a Redo resets: the selected consumers (all of them when none
 * are named) plus every consumer between the source and each of them. Redoing
 * a review without the build it reviewed would re-review the build made from
 * the old version.
 */
function redoSet(
  source: MissionTask, consumers: readonly Consumer[], requested: readonly string[] | undefined, tasks: readonly MissionTask[],
): readonly MissionTask[] {
  if (requested === undefined) return consumers.map((c) => c.task);
  const byId = new Map(consumers.map((c) => [c.task.id as string, c]));
  const chosen = new Set<string>();
  for (const id of requested) {
    if (!byId.has(id)) {
      // Read by a person: the task by its key, the id only in the details.
      const named = tasks.find((t) => t.id === id)?.key;
      const message = named === undefined
        ? `That task did not use the output of '${source.key}'.`
        : `'${named}' did not use the output of '${source.key}'.`;
      throw TandemiseError.validation(message, { taskId: id });
    }
    // Walk back along what each consumer used; it ends at the source, which is not a consumer.
    for (let cursor = byId.get(id); cursor !== undefined && !chosen.has(cursor.task.id); cursor = byId.get(cursor.used.taskId ?? '')) {
      chosen.add(cursor.task.id);
    }
  }
  return consumers.filter((c) => chosen.has(c.task.id)).map((c) => c.task);
}
