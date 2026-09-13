import type { Migration } from './types.js';

/**
 * What the next attempt must be told, kept apart from what the row shows.
 *
 * `status_reason` carried both, and they are not the same thing. It is the
 * line a person reads - "Waiting for a runtime slot", "Waiting for you: sign in"
 * - and it changes whenever the task waits on anything. The feedback a gate
 * measured has to survive those waits to reach the retry's prompt; sharing the
 * column meant any wait between a failed gate and the retry replaced the one
 * thing the retry most needed to know with a remark about the queue.
 *
 * Backfilled for tasks that are waiting to be retried or were left blocked or
 * failed: until now their `status_reason` was that feedback. NULL otherwise.
 */
export const migration007: Migration = {
  version: 7,
  name: 'task_retry_feedback',
  up: `
ALTER TABLE mission_tasks ADD COLUMN retry_feedback TEXT;
UPDATE mission_tasks SET retry_feedback = status_reason
  WHERE attempts > 0 AND status IN ('READY','BLOCKED','FAILED') AND status_reason IS NOT NULL;
`,
};
