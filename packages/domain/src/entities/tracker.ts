import type { Brand, Timestamp, TrackerItemId, WorkspaceId } from '@tandemise/shared';

/**
 * The project's primary tracker, as Tandemise sees it (spec §6).
 *
 * Plan Task 2 declares the item shapes here so the store can cache the board;
 * Task 4 adds the port, `trackerRef()` and the pure helpers to this file.
 */

/**
 * A tracker item's normalised reference, `<tracker>:<key>` (`youtrack:GAR-12`,
 * `github:acme/web#42`), the relay's normalisation. Stored as plain text.
 */
export type TrackerRef = Brand<string, 'TrackerRef'>;

/**
 * One item as the tracker reports it (spec §6), plus `createdAt`, which the
 * board needs to keep the older of two duplicates (plan Task 8).
 */
export interface TrackerItem {
  readonly ref: TrackerRef;
  readonly key: string;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly state: string;
  readonly assignee: string | null;
  /** ISO 8601, the tracker's own. */
  readonly updatedAt: string;
  /** ISO 8601, the tracker's own. */
  readonly createdAt: string;
  readonly type?: string;
}

/** A cached board item: the tracker's item plus what Tandemise keeps about it. */
export interface TrackedItem extends TrackerItem {
  readonly id: TrackerItemId;
  readonly workspaceId: WorkspaceId;
  /**
   * The state Tandemise last wrote; null if it never wrote one. Write-back
   * moves the item only while it is still in this state, so a person's own
   * change always wins (spec §6.3, plan Review Focus 3).
   */
  readonly writtenState: string | null;
  readonly refreshedAt: Timestamp;
}

/** The two comments Tandemise keeps on an item, one each (spec §6, P14 rulings 7 and 8). */
export const TRACKER_COMMENT_MARKERS = ['tandemise:sources', 'tandemise:activity'] as const;
export type TrackerCommentMarker = (typeof TRACKER_COMMENT_MARKERS)[number];

/** The comment Tandemise wrote per `(item, marker)`, with the body last written. */
export interface TrackerCommentRow {
  readonly workspaceId: WorkspaceId;
  readonly itemRef: string;
  readonly marker: TrackerCommentMarker;
  readonly commentId: string;
  readonly body: string;
  readonly postedAt: Timestamp;
  readonly updatedAt: Timestamp;
}
