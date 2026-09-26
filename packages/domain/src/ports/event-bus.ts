import type { MissionId } from '@tandemise/shared';
import type { RunEventRecord } from '../event.js';

/**
 * In-process publish/subscribe for live UI updates. The durable log is the
 * source of truth; this is only the notification edge, so a dropped subscriber
 * never loses data - it re-reads from `EventRepositoryPort` by sequence.
 */
export interface EventBusPort {
  publish(record: RunEventRecord): void;
  subscribe(listener: (record: RunEventRecord) => void, filter?: { missionId?: MissionId }): () => void;
}

/** Coarse-grained "something changed" signal for list/detail projections. */
export type ProjectionTopic =
  | 'missions' | 'tasks' | 'approvals' | 'artifacts' | 'runtimes'
  | 'integrations' | 'targets' | 'workspaces' | 'decisions' | 'checks' | 'criteria' | 'refinement';

export interface ProjectionBusPort {
  invalidate(topic: ProjectionTopic, scope?: { missionId?: MissionId }): void;
  subscribe(listener: (topic: ProjectionTopic, scope: { missionId?: MissionId }) => void): () => void;
}
