import type { ArtifactId, FeedbackId, TaskId, Timestamp } from '@tandemise/shared';
import type { ArtifactHandoff } from './artifact.js';

export const FEEDBACK_STATUSES = ['open', 'queued', 'in_round', 'addressed', 'dismissed'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
/** Given and not yet taken into a round: what a card counts as "notes pending". */
export const PENDING_FEEDBACK_STATUSES: readonly FeedbackStatus[] = ['open', 'queued'];
export const FEEDBACK_TEXT_MAX = 4000;

export const RUN_PURPOSES = ['round', 'tighten', 'feedback', 'retry'] as const;
export type RunPurpose = (typeof RUN_PURPOSES)[number];

/** Reserved for P3 (uploads, hand-backs); always empty in P2. */
export type FeedbackAttachment = Readonly<Record<string, unknown>>;

export interface FeedbackItem {
  readonly id: FeedbackId;
  readonly taskId: TaskId;
  /** Feedback about one output; null for the whole task. */
  readonly artifactId: ArtifactId | null;
  /** A person member, an agent member (AI review findings) or `system:runtime`. */
  readonly authorId: string;
  /** The P0 on-behalf-of rule: the principal's member, or `system` for engine-authored findings. */
  readonly recordedBy: string;
  readonly text: string;
  readonly attachments: readonly FeedbackAttachment[];
  readonly status: FeedbackStatus;
  /** The round that addresses it, once known. */
  readonly round: number | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** Declines are entries like any other change, so the card can show them next to the note they answer. */
export const DECLINED_PREFIX = 'Declined:';
export function isDeclinedChange(what: string): boolean {
  return what.trimStart().toLowerCase().startsWith(DECLINED_PREFIX.toLowerCase());
}

/**
 * Every feedback id a handoff cites, in order of first appearance. One entry
 * may answer several notes ("fb_a, fb_b"): `changed` holds at most three
 * entries and a round can carry more notes than that.
 */
export function citedFeedbackIds(handoff: Pick<ArtifactHandoff, 'changed'> | null | undefined): readonly string[] {
  const ids = new Set<string>();
  for (const change of handoff?.changed ?? []) {
    for (const match of (change.feedback ?? '').matchAll(/fb_[0-9a-z]{20}/g)) ids.add(match[0]);
  }
  return [...ids];
}
