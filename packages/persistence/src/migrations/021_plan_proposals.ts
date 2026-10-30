import type { Migration } from './types.js';

/**
 * Replanning the rest of a mission (replan spec).
 *
 * A replan changes nothing until its plan card is approved: the new steps
 * wait here, keyed by the card. Approving writes them beside the kept steps
 * and drops the row; rejecting only drops the row, so the mission is exactly
 * as it was. Additive only.
 */
export const migration021: Migration = {
  version: 21,
  name: 'plan_proposals',
  up: `
CREATE TABLE plan_proposals (
  approval_id TEXT PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  tasks TEXT NOT NULL,
  replaces TEXT NOT NULL DEFAULT '[]',
  resume_status TEXT NOT NULL,
  plan_fit_approval_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_plan_proposals_mission ON plan_proposals(mission_id);
`,
};
