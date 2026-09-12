import type { RuntimeProfileId, TaskId } from '@tandemise/shared';

/**
 * "Run this one task on that runtime instead" (MVP.md §9.5).
 *
 * The override is deliberately **not** persisted and is consumed by the attempt
 * that reads it. A user retrying a stuck task on a different worker is making a
 * statement about this attempt, not editing their workspace's routing policy;
 * writing it to `workspace.routing` would silently change every future mission
 * and there would be no obvious way to undo it.
 *
 * In-memory therefore means: a daemon restart forgets the override and the task
 * goes back to the routing the user actually configured, which is the right
 * answer for a hint whose whole scope was one retry.
 */
export class RuntimeOverrides {
  readonly #byTask = new Map<TaskId, RuntimeProfileId>();

  set(taskId: TaskId, profileId: RuntimeProfileId): void {
    this.#byTask.set(taskId, profileId);
  }

  /** Reads and clears: an override survives exactly one dispatch. */
  take(taskId: TaskId): RuntimeProfileId | undefined {
    const found = this.#byTask.get(taskId);
    this.#byTask.delete(taskId);
    return found;
  }

  clear(taskId: TaskId): void {
    this.#byTask.delete(taskId);
  }
}
