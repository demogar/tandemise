import type { EventBusPort, ProjectionBusPort, ProjectionTopic, RunEventRecord, MissionId } from '@tandemise/domain';

/**
 * In-process pub/sub.
 *
 * Neither bus is a queue and neither is durable: the event log in SQLite is the
 * durable record, and a client that misses a notification re-reads by sequence.
 * That is what lets these be this simple, and it is the reason a slow subscriber
 * can never apply backpressure to a running mission.
 */
export class InMemoryEventBus implements EventBusPort {
  readonly #listeners = new Set<{ fn: (r: RunEventRecord) => void; missionId?: MissionId }>();

  publish(record: RunEventRecord): void {
    for (const l of this.#listeners) {
      if (l.missionId && l.missionId !== record.missionId) continue;
      // A throwing subscriber must not abort the publish loop or the run that
      // triggered it.
      try { l.fn(record); } catch { /* ignored by design */ }
    }
  }

  subscribe(listener: (record: RunEventRecord) => void, filter?: { missionId?: MissionId }): () => void {
    const entry = { fn: listener, ...(filter?.missionId ? { missionId: filter.missionId } : {}) };
    this.#listeners.add(entry);
    return () => this.#listeners.delete(entry);
  }

  get subscriberCount(): number {
    return this.#listeners.size;
  }
}

export class InMemoryProjectionBus implements ProjectionBusPort {
  readonly #listeners = new Set<(t: ProjectionTopic, s: { missionId?: MissionId }) => void>();

  invalidate(topic: ProjectionTopic, scope: { missionId?: MissionId } = {}): void {
    for (const l of this.#listeners) {
      try { l(topic, scope); } catch { /* ignored by design */ }
    }
  }

  subscribe(listener: (t: ProjectionTopic, s: { missionId?: MissionId }) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
