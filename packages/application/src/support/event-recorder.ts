import type {
  EventBusPort, EventRepositoryPort, ProjectionBusPort, ProjectionTopic, RunEventRecord,
  TandemiseEventBody,
} from '@tandemise/domain';
import type { Clock, MissionId, RunId, TaskId, WorkspaceId } from '@tandemise/shared';
import { ids } from '@tandemise/shared';

export interface EventScope {
  readonly workspaceId: WorkspaceId;
  readonly missionId: MissionId;
  readonly taskId?: TaskId | null;
  readonly runId?: RunId | null;
  readonly roleId?: string | null;
  readonly runtimeProfileId?: string | null;
}

/**
 * The one path from "something happened" to the mission timeline.
 *
 * Persist first, publish second, always in that order and never batched. The
 * durable log is the source of truth (MVP.md §20.3): a subscriber that misses a
 * publish re-reads by sequence, whereas an event that was published but never
 * written is simply gone - and with it the causal record that recovery and the
 * timeline both depend on.
 */
export class EventRecorder {
  constructor(
    private readonly events: EventRepositoryPort,
    private readonly bus: EventBusPort,
    private readonly projections: ProjectionBusPort,
    private readonly clock: Clock,
  ) {}

  record(scope: EventScope, body: TandemiseEventBody): RunEventRecord {
    const record = this.events.append({
      id: ids.event(),
      workspaceId: scope.workspaceId,
      missionId: scope.missionId,
      taskId: scope.taskId ?? null,
      runId: scope.runId ?? null,
      roleId: scope.roleId ?? null,
      runtimeProfileId: scope.runtimeProfileId ?? null,
      body,
      createdAt: this.clock.now(),
    });
    this.bus.publish(record);
    return record;
  }

  note(scope: EventScope, text: string, level: 'info' | 'warn' | 'error' = 'info'): RunEventRecord {
    return this.record(scope, { type: 'note', text, level });
  }

  /** Coarse "this list changed" signal for the projection subscribers. */
  invalidate(topic: ProjectionTopic, missionId?: MissionId): void {
    this.projections.invalidate(topic, missionId ? { missionId } : undefined);
  }
}
