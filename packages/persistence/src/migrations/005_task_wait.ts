import type { Migration } from './types.js';

/**
 * A task may wait for something outside this machine.
 *
 * An end-to-end process does not stop at "push the code": it waits for CI, then
 * merges, then waits for the deploy, then checks the deployed thing. Every one
 * of those is a wait on a system Tandemise does not control.
 *
 * Modelling it as its own kind of step matters for cost, not just tidiness. The
 * obvious alternative - an agent that polls in a loop - re-sends its whole
 * context on every poll, so a ten-minute CI wait is billed as a conversation.
 * A wait step runs a command on an interval and holds no model at all.
 *
 * NULL for every existing row and for every step that is not a wait.
 */
export const migration005: Migration = {
  version: 5,
  name: 'task_wait',
  up: `
ALTER TABLE mission_tasks ADD COLUMN wait_policy TEXT;
`,
};
