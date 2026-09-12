import type { Migration } from './types.js';

/**
 * A task may be carried out by a person.
 *
 * Real processes contain steps no agent can do: a design made in Figma, a
 * setting changed in a third-party console, an account someone has to create.
 * They were previously outside the system, which meant the work that depended
 * on them either failed or was quietly left out of the plan. Recording the
 * executor keeps them in the dependency graph, where the rest of the mission
 * can wait for them honestly.
 *
 * Every existing row is an agent task, which is what the default says.
 */
export const migration003: Migration = {
  version: 3,
  name: 'task_executor',
  up: `
ALTER TABLE mission_tasks ADD COLUMN executor TEXT NOT NULL DEFAULT 'agent';

CREATE INDEX ix_mission_tasks_executor ON mission_tasks (executor);
`,
};
