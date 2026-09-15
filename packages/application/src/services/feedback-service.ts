import type {
  ApprovalRepositoryPort, ArtifactRepositoryPort, FeedbackRepositoryPort, MemberRepositoryPort, Mission,
  MissionRepositoryPort, MissionTask, RunRepositoryPort, TaskRepositoryPort, UnitOfWork,
} from '@tandemise/domain';
import type {
  DismissFeedbackRequest, DownstreamImpactView, FeedbackGivenView, FeedbackView, GiveFeedbackRequest, StartRoundRequest,
  TaskFeedbackView, TaskView,
} from '@tandemise/api-contract';
import type { FeedbackId, TaskId } from '@tandemise/shared';
import { TandemiseError, asId } from '@tandemise/shared';
import type { FeedbackService, PendingFeedback, ProjectionService } from '../services.js';
import type { FeedbackRounds } from '../engine/feedback-rounds.js';
import type { SchedulerService } from '../engine/scheduler.js';
import type { EventRecorder } from '../support/event-recorder.js';
import { actorFor, type Caller } from '../support/identity.js';
import { isOutputApproval } from '../support/approval-view.js';
import { CLOSED_MISSION_MESSAGE, feedbackEffectFor, missionTakesRounds } from '../support/feedback-rules.js';
import { toFeedbackView, toImpactView } from '../support/feedback-view.js';

export interface FeedbackServiceDeps {
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly runs: RunRepositoryPort;
  readonly approvals: ApprovalRepositoryPort;
  readonly artifacts: ArtifactRepositoryPort;
  readonly feedback: FeedbackRepositoryPort;
  readonly members: MemberRepositoryPort;
  readonly rounds: FeedbackRounds;
  readonly projections: ProjectionService;
  readonly unitOfWork: UnitOfWork;
  readonly recorder: EventRecorder;
  readonly scheduler: Pick<SchedulerService, 'wake'>;
}

/**
 * Notes on a task and the rounds they start (spec §2, §3, §8).
 *
 * What a note does is read from the task's state by `feedbackEffectFor`; the
 * rounds themselves are `FeedbackRounds`' job, so the executor and the review
 * pipeline reopen tasks exactly as a person's note does.
 */
export class FeedbackServiceImpl implements FeedbackService {
  constructor(private readonly deps: FeedbackServiceDeps) {}

  give(caller: Caller, taskId: TaskId, request: GiveFeedbackRequest, options: { readonly forceDownstream?: 'keep' } = {}): FeedbackGivenView {
    const { deps } = this;
    // One unit: a round that fails to start leaves no note behind it and no
    // card decided for a round that never came.
    const pending = deps.recorder.deferred(() => deps.unitOfWork.transaction(() => this.beginGive(caller, taskId, request, options)));
    return this.afterGive(pending);
  }

  beginGive(caller: Caller, taskId: TaskId, request: GiveFeedbackRequest, options: { readonly forceDownstream?: 'keep' } = {}): PendingFeedback {
    const { deps } = this;
    const task = this.#task(taskId);
    const mission = this.#mission(task);
    // Resolved before anything is written: someone off the team changes nothing.
    const { actorId, recordedBy } = actorFor(deps, mission.workspaceId, caller, request.onBehalfOf);
    this.#requireOpenMission(mission);
    if (task.executor === 'wait') {
      throw new TandemiseError('PRECONDITION_FAILED', `'${task.key}' is a wait step; nothing reads feedback there.`, {
        details: { taskId },
      });
    }
    const artifactId = request.artifactId === undefined ? null : asId<'ArtifactId'>(request.artifactId);
    const artifact = artifactId === null ? undefined : deps.artifacts.get(artifactId);
    if (artifactId !== null && artifact?.taskId !== task.id) {
      // Read by a person: the output by its title, the id only in the details.
      const named = artifact === undefined ? 'That output' : `'${artifact.title}'`;
      throw TandemiseError.validation(`${named} is not an output of '${task.key}'.`, { artifactId, taskId });
    }
    const base = { task, text: request.text, artifactId, authorId: actorId, recordedBy };
    const effect = feedbackEffectFor(task, deps.approvals.pendingForTask(task.id), deps.runs);

    if (effect.kind === 'queue' || effect.kind === 'attach') {
      const item = deps.rounds.record({ ...base, status: effect.kind === 'queue' ? 'queued' : 'open', round: task.round ?? 1 });
      return { view: { feedback: toFeedbackView(deps, item), impact: null, roundStarted: null, roundNotes: 0 }, begun: null };
    }

    // Every other state starts the next round. Work that already used this
    // task's output is the person's call (spec §3): unless the caller has made
    // it, the note waits as open and the impact is returned for the dialog.
    // A round refuses to start past such work without that choice, so this
    // holds for a review card and a failed task too, not only a finished one.
    const impact = deps.rounds.impactOf(task);
    const downstream = impact.consumers.length === 0 ? 'none' : options.forceDownstream;
    if (downstream === undefined) {
      const item = deps.rounds.record({ ...base, status: 'open', round: null });
      const open = deps.feedback.listByTask(task.id).filter((i) => i.status === 'open').map((i) => i.id);
      return { view: { feedback: toFeedbackView(deps, item), impact: toImpactView(impact, open), roundStarted: null, roundNotes: 0 }, begun: null };
    }

    const card = effect.kind === 'review' ? effect.card : undefined;
    const recorded = deps.rounds.record({ ...base, status: 'open', round: null });
    if (card !== undefined) deps.rounds.decideReviewCard(card, { actorId, recordedBy, note: this.#joiningNotes(task) });
    const begun = deps.rounds.beginRound({
      task, feedbackIds: [recorded.id], downstream, actorId, ...(card === undefined ? {} : { keepCardId: card.id }),
    });
    return {
      view: {
        feedback: toFeedbackView(deps, deps.feedback.get(recorded.id) ?? recorded), impact: null, roundStarted: begun.task.round ?? null,
        roundNotes: deps.feedback.listByTask(task.id).filter((i) => i.status === 'in_round' && i.round === begun.task.round).length,
      },
      begun,
    };
  }

  afterGive(pending: PendingFeedback): FeedbackGivenView {
    if (pending.begun !== null) {
      // Committed now, so a stopped pass settling against its row finds the round.
      this.deps.rounds.stopOvertaken(pending.begun);
      this.deps.scheduler.wake();
    }
    return pending.view;
  }

  startRound(caller: Caller, taskId: TaskId, request: StartRoundRequest): TaskView {
    const { deps } = this;
    const task = this.#task(taskId);
    const mission = this.#mission(task);
    const { actorId, recordedBy } = actorFor(deps, mission.workspaceId, caller, request.onBehalfOf);
    this.#requireOpenMission(mission);
    // The card and the consumers are read inside the unit, so a card decided or
    // a dependent started between reading and writing cannot slip past it.
    const begun = deps.recorder.deferred(() => deps.unitOfWork.transaction(() => {
      const current = deps.tasks.get(task.id) ?? task;
      const card = deps.approvals.pendingForTask(task.id).find((a) => isOutputApproval(a, current, deps.runs));
      const consumers = deps.rounds.impactOf(current).consumers.length;
      if (card !== undefined) deps.rounds.decideReviewCard(card, { actorId, recordedBy, note: this.#joiningNotes(current) });
      return deps.rounds.beginRound({
        task: current,
        feedbackIds: request.feedbackIds,
        actorId,
        // With nothing downstream the choice has no meaning, and "none" is the only one the round accepts.
        downstream: consumers === 0 ? 'none' : request.downstream,
        ...(card === undefined ? {} : { keepCardId: card.id }),
        ...(request.redoTaskIds === undefined ? {} : { redoTaskIds: request.redoTaskIds }),
      });
    }));
    // Only after the commit: a stopped pass re-reads its row as it settles and must find the round there.
    deps.rounds.stopOvertaken(begun);
    deps.scheduler.wake();
    return deps.projections.taskView(task.id);
  }

  list(taskId: TaskId): TaskFeedbackView {
    const { deps } = this;
    const task = this.#task(taskId);
    const items = deps.feedback.listByTask(task.id);
    const open = items.filter((i) => i.status === 'open').map((i) => i.id);
    return {
      taskId: task.id,
      round: task.round ?? 1,
      items: items.map((i) => toFeedbackView(deps, i)),
      pendingImpact: open.length > 0 ? this.#pendingImpact(task, open) : null,
    };
  }

  dismiss(caller: Caller, id: FeedbackId, request: DismissFeedbackRequest): FeedbackView {
    const { deps } = this;
    const item = deps.feedback.get(id);
    // Worded for a person: the id is in the details, not the message.
    if (item === undefined) throw new TandemiseError('NOT_FOUND', 'That note no longer exists.', { details: { id } });
    const task = this.#task(item.taskId);
    const mission = this.#mission(task);
    const { actorId } = actorFor(deps, mission.workspaceId, caller, request.onBehalfOf);
    if (item.status !== 'open' && item.status !== 'queued') {
      // A round already carries it, or it was answered: taking it back now would leave the round citing nothing.
      throw new TandemiseError('CONFLICT', `A note that is ${item.status.replace('_', ' ')} cannot be dismissed.`, {
        details: { feedbackId: id, status: item.status },
      });
    }
    const dismissed = deps.feedback.update(id, { status: 'dismissed' });
    deps.recorder.record(
      { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, roleId: task.roleId, actorId },
      { type: 'feedback.dismissed', feedbackId: id },
    );
    deps.recorder.invalidate('tasks', mission.id);
    return toFeedbackView(deps, dismissed);
  }

  /**
   * The round open notes are waiting on, when the task is where a note starts
   * one. An attached note (the task has not run) or a queued one (a pass will
   * read it) waits for nothing a person has to confirm.
   */
  #pendingImpact(task: MissionTask, open: readonly string[]): DownstreamImpactView | null {
    const effect = feedbackEffectFor(task, this.deps.approvals.pendingForTask(task.id), this.deps.runs);
    if (effect.kind === 'queue' || effect.kind === 'attach') return null;
    return toImpactView(this.deps.rounds.impactOf(task), open);
  }

  /**
   * Every note the round will carry, as the decided card's note: a round joins
   * all open notes, and a card quoting only the one clicked would misstate what
   * was asked for.
   */
  #joiningNotes(task: MissionTask): string {
    return this.deps.feedback.listByTask(task.id).filter((i) => i.status === 'open').map((i) => i.text).join('\n\n');
  }

  /** A note on a mission that can take no more rounds would wait for nothing. */
  #requireOpenMission(mission: Mission): void {
    if (!missionTakesRounds(mission)) {
      throw new TandemiseError('PRECONDITION_FAILED', CLOSED_MISSION_MESSAGE, { details: { missionId: mission.id, status: mission.status } });
    }
  }

  #task(id: TaskId): MissionTask {
    const task = this.deps.tasks.get(id);
    if (task === undefined) throw TandemiseError.notFound('Task', id);
    return task;
  }

  #mission(task: MissionTask): Mission {
    const mission = this.deps.missions.get(task.missionId);
    if (mission === undefined) throw TandemiseError.notFound('Mission', task.missionId);
    return mission;
  }
}
