// PM6 — a fix predicted quick whose implement step edits src/auth/session.ts (SCRIPTED_TOUCH). When the ship step
// starts, the measured change is re-profiled: the mission's events say "It touched src/auth/session.ts, so I added a
// security review.", a Security review step runs, and only then the pull request opens.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { autoDraft, headerAction, openMission, ship, shot, waitStatus, whyText } from '../common.mjs';

const c = await context();
const { page, until } = c;
const ev = new Evidence('PM6', 'A quick fix that touches auth gets a security review before its pull request');
const SENTENCE = 'It touched src/auth/session.ts, so I added a security review.';

try {
  const id = await autoDraft(c, 'fix: typo in the login button label SCRIPTED_TOUCH=src/auth/session.ts');
  ev.note(`mission ${id}`);
  await openMission(c, id);
  await headerAction(c, 'Plan');
  await waitStatus(c, id, ['EXECUTING', 'COMPLETE'], 60_000);

  const predicted = await whyText(c, id, (t) => t.includes('lane'));
  ev.check('predicted quick: "Quick lane: one step, then a pull request."', predicted.includes('Quick lane: one step, then a pull request.'), predicted);
  await shot(c, ev, 'predicted');

  const review = await until(async () => { const t = (await c.task(id, 'security_review')); return t && t.status === 'SUCCEEDED' && t; }, { label: 'security review ran', timeoutMs: 150_000 });
  ev.check('a Security review step was added and ran', review.title === 'Security review' && review.status === 'SUCCEEDED', { title: review.title, status: review.status });

  const events = await c.events(id);
  const notes = events.filter((e) => e.body?.type === 'note').map((e) => e.body.text);
  ev.check(`the mission's events say "${SENTENCE}"`, notes.includes(SENTENCE), notes.slice(-6));

  await openMission(c, id, 'timeline');
  const timeline = await until(async () => { const t = await page.text('main'); return t.includes(SENTENCE) && t; }, { label: 'timeline line', timeoutMs: 20_000 });
  ev.check('the Timeline shows it in those words', timeline.includes(SENTENCE), timeline.slice(0, 300));
  await shot(c, ev, 'timeline');

  const measured = await whyText(c, id, (t) => t.includes('security review'));
  ev.check('the Plan header now says "Added a security review because it touches auth."', measured.includes('Added a security review because it touches auth.'), measured);
  ev.check('…and lists the Security review step', measured.includes('Security review · role model'), measured);
  await shot(c, ev, 'measured');

  const shipped = await until(async () => { const v = await ship(c, id); return v.prs.length > 0 && v; }, { label: 'ship opened', timeoutMs: 120_000 });
  ev.check('GET /ship: the pull request opened after the review', shipped.prs.length === 1, shipped);
  const tasks = await c.tasks(id);
  const reviewDone = Date.parse(tasks.security_review.finishedAt);
  const opened = (await c.events(id)).find((e) => e.body?.type === 'ship.pr_opened');
  ev.check('…and only after the security review finished', opened !== undefined && Date.parse(opened.createdAt) >= reviewDone, { reviewDone: tasks.security_review.finishedAt, opened: opened?.createdAt });
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
}
c.close(); ev.save();
