// PM2 — a tiny fix with CI green and auto-merge off (the shipped policy): the ship card says "Waiting for your
// review", "Auto-merge is off for this project." and what would have happened; the Inbox has "Review and merge".
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { setRepo } from '../../../fake-gh.mjs';
import { SCRATCH } from '../../p0/lib/ctx.mjs';
import { REPO, autoDraft, ghCalls, headerAction, openMission, ship, shipCardText, shot, waitStatus } from '../common.mjs';

const c = await context();
const { until } = c;
const ev = new Evidence('PM2', 'With auto-merge off, a green tiny fix asks for review and says what would have happened');

try {
  // CI green on every commit from here on.
  setRepo(`${SCRATCH}/gh`, REPO, { defaultChecks: [{ name: 'unit', conclusion: 'success' }, { name: 'lint', conclusion: 'success' }] });
  const id = await autoDraft(c, 'fix: typo in the profile title');
  ev.note(`mission ${id}`);
  await openMission(c, id);
  await headerAction(c, 'Plan');
  await waitStatus(c, id, ['EXECUTING'], 60_000);
  const view = await until(async () => { const v = await ship(c, id); return v.stage === 'review' && v.prs[0]?.decision !== null && v; }, { label: 'ship asks', timeoutMs: 180_000 });
  const d = view.prs[0].decision;
  ev.check('GET /ship: waiting for your review', view.headline === 'Waiting for your review', view.headline);
  ev.check('…the decision asks, with "Auto-merge is off for this project."', d.verdict === 'ask' && d.reasons.includes('Auto-merge is off for this project.'), d);
  ev.check('…and would have merged: score 1 of 2 (no independent review in the quick lane)', d.wouldHave === 'would have merged: score 1 of 2', d.wouldHave);
  const card = await shipCardText(c, id, (t) => t.includes('Waiting for your review'));
  ev.check('the ship card says "Waiting for your review"', card.includes('Waiting for your review'), card);
  ev.check('…"Auto-merge is off for this project."', card.includes('Auto-merge is off for this project.'), card);
  ev.check('…"What would have happened with auto-merge on: would have merged: score 1 of 2"', card.includes('What would have happened with auto-merge on: would have merged: score 1 of 2'), card);
  ev.check('…and a Merge button', card.includes('Merge'), card);
  await shot(c, ev, 'ship-card');
  const approvals = await c.approvals(id);
  ev.check('the Inbox has "Review and merge"', approvals.some((a) => a.title.startsWith('Review and merge')), approvals.map((a) => a.title));
  ev.check('fake gh saw no pr merge', !ghCalls().some((x) => x.args[0] === 'pr' && x.args[1] === 'merge'));
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
}
c.close(); ev.save();
