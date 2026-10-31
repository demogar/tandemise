import { useSyncExternalStore } from 'react';

/**
 * Which held step's terminal is open in this window, if any.
 *
 * A module store rather than component state: Hold is pressed on a feed card
 * or in the task drawer, and the panel itself sits over the whole mission
 * screen, so the two are far apart in the tree. Closing the panel only
 * forgets this; the hold and its terminal go on in the daemon.
 */
let openTaskId: string | null = null;
const listeners = new Set<() => void>();

export function openTerminal(taskId: string): void {
  openTaskId = taskId;
  for (const listener of listeners) listener();
}

export function closeTerminal(): void {
  openTaskId = null;
  for (const listener of listeners) listener();
}

export function useOpenTerminal(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => openTaskId,
  );
}
