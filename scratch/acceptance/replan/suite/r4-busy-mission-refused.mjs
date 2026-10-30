// R4 — A step still running refuses a replan, by name, and nothing changes.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { ensureTeam, startMission, waitTask } from '../../p3/common.mjs';

const c = await context();
const { api } = c;
const ev = new Evidence('R4', 'A mission with a step still running refuses a replan and stays as it was');

await ensureTeam(c);
const goal = 'Apply to the role, busy SCRIPTED_SLOW_20S';
const missionId = await startMission(c, goal, 'Plan fit chain');
await waitTask(c, missionId, 'intake', (t) => t.status === 'RUNNING', 'intake running', 30_000);
const refused = await api.post(`/v1/missions/${missionId}/replan`, { note: 'now' }).then(() => null, (e) => e);
ev.check('proof (API): refused with the reason, naming the step', refused !== null && refused.status >= 400 && /Wait for 'intake' to finish, or stop it, before planning the rest again\./.test(refused.message), refused?.message);
const after = (await api.get(`/v1/missions/${missionId}`)).mission;
ev.check('proof (API): the mission kept executing', after.status === 'EXECUTING', after.status);
await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: R4 proven' }).catch(() => undefined);

c.close(); ev.save();
