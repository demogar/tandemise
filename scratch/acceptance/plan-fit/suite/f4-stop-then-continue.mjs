// F4 — Continue as planned. The person overrides the stop; draft and polish run on what intake wrote.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { docsSize, waitTask } from '../../p3/common.mjs';
import { CARD, stoppedMission } from '../common.mjs';

const c = await context();
const { page } = c;
await docsSize(c);
const ev = new Evidence('F4', 'Continuing as planned releases the steps after a stop');

const { missionId } = await stoppedMission(c, 'continue');
await c.decideInInbox(CARD, { filter: 'For me', option: 'Continue as planned' });
await page.screenshot(ev.shot('inbox-decided-continue'));
const polish = await waitTask(c, missionId, 'polish', (t) => t.status === 'SUCCEEDED', 'polish finished', 90_000).catch(() => c.task(missionId, 'polish'));
const intake = await c.task(missionId, 'intake');
ev.check('proof (API): draft and polish ran', polish.status === 'SUCCEEDED' && (await c.task(missionId, 'draft')).status === 'SUCCEEDED', polish.status);
ev.check('proof (API): intake stayed round 1', intake.round === 1, intake.round);
ev.check('proof (API): the card reads approved', (await c.approvals(missionId)).find((a) => a.title === CARD)?.status === 'APPROVED');

c.close(); ev.save();
