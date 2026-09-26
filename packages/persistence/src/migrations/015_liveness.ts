import type { Migration } from './types.js';

/**
 * Nothing waits silently (P9 spec §4).
 *
 * Additive only:
 *
 *  - `runs.last_event_at` is when the agent last wrote an event. The heartbeat
 *    is throttled for recovery; this is exact, and silence is measured from it.
 *    Existing runs read their heartbeat, else their start.
 *  - `runs.watch_snoozed_until` is "Keep waiting" on a quiet run: its Inbox row
 *    stays hidden until then, and any agent event clears it.
 *
 * Whether a mission is stalled is not stored: it is derived from the rows on
 * every read, so it can never disagree with them.
 */
export const migration015: Migration = {
  version: 15,
  name: 'liveness',
  up: `
ALTER TABLE runs ADD COLUMN last_event_at TEXT;
ALTER TABLE runs ADD COLUMN watch_snoozed_until TEXT;
UPDATE runs SET last_event_at = COALESCE(heartbeat_at, started_at);
`,
};
