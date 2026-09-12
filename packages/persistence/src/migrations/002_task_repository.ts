import type { Migration } from './types.js';

/**
 * A task may name the repository it works in.
 *
 * A project is often more than one repository - a web app, a mobile client and
 * shared tooling that ship together - and a change to it lands in several of
 * them. Until now a mission carried one repository and every task inherited it,
 * so work spanning two repositories had to be split into separate missions that
 * knew nothing about each other, losing the dependency ordering that made them
 * one piece of work.
 *
 * NULL means "the mission's repository", which is what every existing row is
 * and what most tasks will always be.
 */
export const migration002: Migration = {
  version: 2,
  name: 'task_repository',
  up: `
ALTER TABLE mission_tasks ADD COLUMN repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL;

CREATE INDEX ix_mission_tasks_repository ON mission_tasks (repository_id);
`,
};
