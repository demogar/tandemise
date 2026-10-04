// F3 — Send it back with a note. The note briefs intake's round 2, which no longer says stop, so draft and
// polish run on round 2's output.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { docsSize, waitTask } from '../../p3/common.mjs';
import { CARD, stoppedMission } from '../common.mjs';

const c = await context();
const { page, api } = c;
await docsSize(c);
const ev = new Evidence('F3', 'Sending the stopped step back runs its next round, and the plan goes on from it');

const { missionId, intake } = await stoppedMission(c, 'send back');
const note = 'Panama counts as Americas for this role: go on with the CV.';
await c.decideInInbox(CARD, { filter: 'For me', option: 'Send it back with a note', note });
await page.screenshot(ev.shot('inbox-decided-send-back'));
const round2 = await waitTask(c, missionId, 'intake', (t) => t.round === 2 && t.status === 'SUCCEEDED', 'intake round 2', 60_000).catch(() => c.task(missionId, 'intake'));
ev.check('proof (API): intake ran again as round 2', round2.round === 2 && round2.status === 'SUCCEEDED', { round: round2.round, status: round2.status });
const prompt = c.prompts().filter((p) => p.includes(note)).pop() ?? '';
ev.check('round 2 was briefed with the note', prompt.includes(note), prompt.slice(0, 300));
const outputs = (await api.get(`/v1/missions/${missionId}`)).artifacts.filter((a) => a.taskId === intake.id);
const replaced = new Set(outputs.map((a) => a.supersedes).filter(Boolean));
const live = outputs.filter((a) => !replaced.has(a.id));
ev.check('proof (API): round 2\'s output no longer says stop', live.length === 1 && (live[0].handoff?.stop ?? null) === null, live.map((a) => a.handoff));
const polish = await waitTask(c, missionId, 'polish', (t) => t.status === 'SUCCEEDED', 'polish finished', 90_000).catch(() => c.task(missionId, 'polish'));
ev.check('proof (API): draft and polish ran on it', polish.status === 'SUCCEEDED' && (await c.task(missionId, 'draft')).status === 'SUCCEEDED', polish.status);
ev.check('proof (API): no second card was filed', (await c.approvals(missionId)).filter((a) => a.title === CARD).length === 1);

c.close(); ev.save();
