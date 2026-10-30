// Shared by the replan scenarios: a mission on "Plan fit chain" whose intake says the plan no longer
// fits, with the scripted planner answering a replan (SCRIPTED_REPLAN in the goal).
import { stoppedMission } from '../plan-fit/common.mjs';

export { CARD, HELD } from '../plan-fit/common.mjs';
export const OPTION = 'Plan the rest again';

export const stoppedForReplan = (c, label) => stoppedMission(c, `${label} SCRIPTED_REPLAN`);

/** The replan's plan card, once filed. */
export const replanCard = (c, missionId) => c.until(
  async () => (await c.approvals(missionId, 'PENDING')).find((a) => a.kind === 'plan' && a.evidence.some((e) => e.label === 'Replan')),
  { label: 'replan card', timeoutMs: 60_000 },
);

/** A step's runs and outputs, by id, to prove a replan left them exactly as they were. */
export const history = (c, taskId) => ({
  runs: c.sql('SELECT id FROM runs WHERE task_id = ? ORDER BY id', taskId).map((r) => r.id),
  artifacts: c.sql('SELECT id FROM artifacts WHERE task_id = ? ORDER BY id', taskId).map((r) => r.id),
});

export const keys = async (c, missionId) => (await c.api.get(`/v1/missions/${missionId}/tasks`)).map((t) => t.key).sort();
