// Shared by the plan-fit scenarios that stop: a mission on "Plan fit chain" whose intake says the plan no longer fits.
import { ensureTeam, startMission, waitTask } from '../p3/common.mjs';

export const CARD = '‘intake’ says the plan no longer fits';
export const HELD = "Waiting for you: 'intake' says the plan no longer fits.";
export const STOP = 'The role is US-only, so the steps after this have nothing to work on.';

/** Starts a stopping mission and waits until intake finished and draft is held. */
export async function stoppedMission(c, label) {
  await ensureTeam(c);
  const goal = `Apply to the role, ${label} SCRIPTED_STOP`;
  const missionId = await startMission(c, goal, 'Plan fit chain');
  const intake = await waitTask(c, missionId, 'intake', (t) => t.status === 'SUCCEEDED', 'intake finished', 60_000);
  const draft = await waitTask(c, missionId, 'draft', (t) => t.statusReason === HELD, 'draft held', 30_000);
  const card = await c.until(async () => (await c.approvals(missionId, 'PENDING')).find((a) => a.title === CARD), { label: 'plan-fit card', timeoutMs: 20_000 });
  return { missionId, goal, intake, draft, card };
}
