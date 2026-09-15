import type { ArtifactHandoff, FeedbackItem } from '@tandemise/domain';
import { citedFeedbackIds, isDeclinedChange } from '@tandemise/domain';
import type { DownstreamImpactView, FeedChange, FeedbackView } from '@tandemise/api-contract';
import type { DownstreamImpact } from '../engine/feedback-rounds.js';
import { LIVE_RUN_STATUSES } from './downstream.js';
import { actorRef, type ActorDeps } from './actors.js';

/**
 * Shared by the feedback thread, the feed card and the reader, so a note is
 * named the same way wherever it shows.
 */
export function toFeedbackView(deps: ActorDeps, item: FeedbackItem): FeedbackView {
  const author = actorRef(deps, item.authorId);
  const recorded = actorRef(deps, item.recordedBy);
  return {
    id: item.id,
    taskId: item.taskId,
    artifactId: item.artifactId,
    author,
    recordedBy: recorded === null || recorded.id === author?.id ? null : recorded,
    text: item.text,
    status: item.status,
    round: item.round,
    createdAt: item.createdAt,
  };
}

/**
 * The changes a handoff lists, each with the notes it answers. Ids that
 * resolve to nothing (a typo in the worker's output, a note on another task)
 * are left out: a card never shows a raw id.
 */
export function resolveChanges(
  deps: ActorDeps,
  handoff: Pick<ArtifactHandoff, 'changed'> | null | undefined,
  items: ReadonlyMap<string, FeedbackItem>,
): readonly FeedChange[] {
  return (handoff?.changed ?? []).map((change) => ({
    what: change.what,
    declined: isDeclinedChange(change.what),
    feedback: citedFeedbackIds({ changed: [change] })
      .map((id) => items.get(id))
      .filter((i): i is FeedbackItem => i !== undefined)
      .map((i) => ({ id: i.id, text: i.text, author: actorRef(deps, i.authorId), status: i.status })),
  }));
}

export function toImpactView(impact: DownstreamImpact, feedbackIds: readonly string[]): DownstreamImpactView {
  return {
    taskId: impact.task.id,
    taskKey: impact.task.key,
    taskTitle: impact.task.title,
    nextRound: (impact.task.round ?? 1) + 1,
    feedbackIds,
    dependents: impact.consumers.map((c) => ({
      taskId: c.task.id,
      key: c.task.key,
      title: c.task.title,
      status: c.task.status,
      usedVersion: impact.usedVersion.get(c.task.id) ?? 1,
      running: LIVE_RUN_STATUSES.includes(c.task.status),
    })),
    defaultChoice: impact.defaultChoice,
  };
}
