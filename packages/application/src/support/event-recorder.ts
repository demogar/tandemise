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
  /** Who did it: a member id, or a system actor. Unset for events nobody in particular caused. */
  readonly actorId?: string | null;
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
  /** Publications held back while a `deferred` block runs; null outside one. */
  #held: (() => void)[] | null = null;

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
      actorId: scope.actorId ?? null,
    });
    this.#publish(() => this.bus.publish(record));
    return record;
  }

  /**
   * Runs `fn` - a unit of work, typically - holding back every publication it
   * makes until it returns, and dropping them if it throws.
   *
   * Persisting inside a transaction and publishing at once let a subscriber
   * see an event the rollback then erased; the log is the truth, and the bus
   * must not get ahead of it. Nested calls join the outermost one.
   *
   * `fn` must be synchronous, as a unit of work is. Only then is everything
   * recorded between the start and the return this block's own: an async `fn`
   * would return at its first await, publish too early, and hold whatever
   * unrelated code recorded meanwhile. The parameter type rejects a function
   * returning a promise at compile time, and the check below catches one that
   * got past it (through `any`, say).
   */
  deferred<T>(fn: () => T extends PromiseLike<unknown> ? never : T): T {
    if (this.#held !== null) return fn();
    const held: (() => void)[] = [];
    this.#held = held;
    let result: T;
    try {
      result = fn();
      if (typeof (result as { then?: unknown } | null | undefined)?.then === 'function') {
        throw new TypeError('EventRecorder.deferred needs a synchronous function; publications were dropped.');
      }
    } finally {
      this.#held = null;
    }
    for (const publish of held) publish();
    return result;
  }

  #publish(publish: () => void): void {
    if (this.#held === null) publish();
    else this.#held.push(publish);
  }

  note(scope: EventScope, text: string, level: 'info' | 'warn' | 'error' = 'info'): RunEventRecord {
    return this.record(scope, { type: 'note', text, level });
  }

  /** Coarse "this list changed" signal for the projection subscribers. */
  invalidate(topic: ProjectionTopic, missionId?: MissionId): void {
    this.#publish(() => this.projections.invalidate(topic, missionId ? { missionId } : undefined));
  }
}
