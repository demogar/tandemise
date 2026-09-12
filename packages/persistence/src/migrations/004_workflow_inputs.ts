import type { Migration } from './types.js';

/**
 * A mission remembers what its workflow was given.
 *
 * A workflow takes inputs - an issue number, a ticket id - and compiles to a
 * plan. Re-planning has to produce the same plan, and the mission timeline has
 * to be able to say what this run was actually about, so the inputs are stored
 * rather than recovered from the goal text someone typed.
 */
export const migration004: Migration = {
  version: 4,
  name: 'workflow_inputs',
  up: `
ALTER TABLE missions ADD COLUMN workflow_inputs TEXT NOT NULL DEFAULT '{}';
`,
};
