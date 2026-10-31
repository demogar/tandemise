// PM7 — Plan careful on a factory draft with no Done-when line: it stays a draft and the feed's "Get it ready" is
// where it goes. After one Done-when line, Plan careful plans it: the plan waits for your approval, and the Plan
// header carries the careful lane line. The ship step is waiting; no pull request yet.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { autoDraft, headerAction, headerButtons, mission, openMission, ship, shot, waitStatus, whyText } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('PM7', 'Plan careful asks for a Done-when line first, then plans with an approval card');

try {
  const id = await autoDraft(c, 'fix: the export button label is wrong');
  ev.note(`mission ${id}`);
  await openMission(c, id, 'plan');
  await headerAction(c, 'Plan careful');

  await until(async () => (await page.evaluate('location.hash')) === `#/missions/${id}`, { label: 'back on the feed', timeoutMs: 10_000 });
  const ready = await until(() => page.evaluate(`document.querySelector('section[aria-label="Get it ready"]')?.innerText ?? ''`), { label: 'Get it ready', timeoutMs: 15_000 });
  ev.check('Plan careful with no criteria opens "Get it ready" on the feed', ready.includes('Get it ready'), ready.slice(0, 300));
  const m = await mission(c, id);
  ev.check('…the mission stays a draft, marked careful', m.status === 'DRAFT' && m.laneRequest === 'careful', { status: m.status, laneRequest: m.laneRequest });
  const buttons = await headerButtons(c);
  ev.check("…and Plan now waits for the Done-when line", buttons.some((b) => b.startsWith("(disabled) Add at least one Done-when")), buttons);
  await shot(c, ev, 'get-ready');

  await page.fill('Add a Done-when criterion', 'The export button reads Export.');
  await sleep(300);
  const added = await page.evaluate(`(() => { const i = document.querySelector('input[aria-label="Add a Done-when criterion"]'); const b = i && [...i.parentElement.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Add' && !x.disabled); if (!b) return false; b.click(); return true; })()`);
  if (!added) throw new Error('no enabled Add beside the Done-when field');
  await until(async () => (await c.api.get(`/v1/missions/${id}/refinement`)).readiness.ready, { label: 'ready', timeoutMs: 15_000 });
  await sleep(800);
  await headerAction(c, 'Plan careful');

  const asked = await waitStatus(c, id, ['AWAITING_PLAN_APPROVAL'], 150_000);
  ev.check('planned careful: the plan waits for your approval', asked === 'AWAITING_PLAN_APPROVAL', asked);
  const cards = (await c.approvals(id, 'PENDING')).filter((a) => a.kind === 'plan');
  ev.check('…with a plan card', cards.length === 1 && cards[0].title.startsWith('Approve the plan for'), cards.map((a) => a.title));

  const why = await whyText(c, id, (t) => t.includes('Careful lane'));
  ev.check('the Plan header carries the lane line "Careful lane"', why.includes('Careful lane'), why);
  ev.check('…and says you chose it', why.includes('You chose it.'), why);
  await shot(c, ev, 'plan');

  const view = await ship(c, id);
  ev.check('GET /ship: waiting, no pull request yet', view.stage === 'waiting' && view.prs.length === 0, view);
  await openMission(c, id);
  await sleep(1000);
  await shot(c, ev, 'plan-card');
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
}
c.close(); ev.save();
