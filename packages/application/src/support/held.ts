/**
 * The abort reason the scheduler uses when a person holds a running task.
 *
 * Like a daemon stop, a hold pauses the work rather than ending it: the run
 * ends RESUMABLE with its session, so the person can resume that session in a
 * terminal and the agent can continue from it afterwards. Treated as a cancel,
 * the session would be lost and the task settled CANCELLED under the person
 * who only wanted to take the keyboard.
 */
export class TaskHeld extends Error {
  constructor() {
    super('A person is holding this task; its session continues in their terminal.');
    this.name = 'TaskHeld';
  }
}

export function isTaskHeld(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof TaskHeld;
}

/** What the work downstream of a held step waits on; the same words hold it and let it go, recovery's included. */
export function heldWaitingReason(task: { readonly key: string }): string {
  return `Waiting for '${task.key}' while it is held.`;
}
