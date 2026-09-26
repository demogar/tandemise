import type { Migration } from './types.js';

/**
 * Model routing (P12 spec §4).
 *
 * Additive only:
 *
 *  - `runs.model` is the model the run was given; NULL means the runtime's own
 *    default (nothing was passed).
 *  - `runs.model_reason` is why ("step override", "retry escalation (attempt 2)").
 *    NULL for a run from before P12, which is read as "not recorded".
 *  - `role_templates.models` is a role's `{model, escalate, economyModel}` JSON.
 *  - `mission_tasks.model_policy` is a workflow step's `{model, escalate, independentOf}` JSON.
 */
export const migration017: Migration = {
  version: 17,
  name: 'models',
  up: `
ALTER TABLE runs ADD COLUMN model TEXT;
ALTER TABLE runs ADD COLUMN model_reason TEXT;
ALTER TABLE role_templates ADD COLUMN models TEXT;
ALTER TABLE mission_tasks ADD COLUMN model_policy TEXT;
`,
};
