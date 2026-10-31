// PM1 — "fix: typo in the settings title", no Done-when line, made in New mission with the workflow left on
// "Let the factory decide", then Plan. No plan approval card; the Plan header reads "Fix · tiny · low risk" and
// "Quick lane: one step, then a pull request."; one agent step, then the ship card reaches "Pull request opened";
// the fake gh saw `pr create` without --draft.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { REPO, ghCalls, headerAction, headerButtons, openMission, prs, ship, shipCardText, shot, waitStatus, whyText } from '../common.mjs';

const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('PM1', 'A tiny fix plans at once in the quick lane and opens a pull request');
const GOAL = 'fix: typo in the settings title';

try {
  await page.navigate('#/missions/new');
  await page.waitForText('What outcome do you want?', { timeoutMs: 30_000 });
  await sleep(400);
  const picked = await page.evaluate(`(() => { const s = [...document.querySelectorAll('select')].find((x) => (x.labels?.[0]?.innerText ?? '').startsWith('Workflow')); return s ? s.options[s.selectedIndex].text.trim() : ''; })()`);
  ev.check('New mission: the workflow defaults to "Let the factory decide"', picked === 'Let the factory decide', picked);
  await page.fill('What outcome do you want?', GOAL);
  await page.select('Repository', 'acceptance-project');
  await page.click('Create and refine …');
  const id = await until(async () => { const h = await page.evaluate('location.hash'); return /#\/missions\/msn_/.test(h) && h.split('/')[2]; }, { label: 'mission page', timeoutMs: 30_000 });
  ev.note(`mission ${id}`);

  await openMission(c, id);
  const buttons = await headerButtons(c);
  ev.check('a factory draft offers Plan, Plan quick and Plan careful, Plan not held back for a Done-when line', ['Plan', 'Plan quick', 'Plan careful'].every((b) => buttons.includes(b)), buttons);
  await shot(c, ev, 'draft');
  await headerAction(c, 'Plan');

  const running = await waitStatus(c, id, ['EXECUTING', 'COMPLETE'], 60_000);
  ev.check('planned and running at once, with no Done-when line', ['EXECUTING', 'COMPLETE'].includes(running), running);
  const approvals = await c.approvals(id);
  ev.check('no "Approve the plan" card', !approvals.some((a) => a.kind === 'plan'), approvals.map((a) => a.title));

  const why = await whyText(c, id, (t) => t.includes('Quick lane'));
  ev.check('Plan header reads "Fix · tiny · low risk"', why.includes('Fix · tiny · low risk'), why);
  ev.check('…and "Quick lane: one step, then a pull request."', why.includes('Quick lane: one step, then a pull request.'), why);
  ev.check('…skipped ceremony in words ("No plan approval.")', why.includes('No plan approval.'), why);
  ev.check('…the step line "Implement · role model"', why.includes('Implement · role model'), why);
  await page.click('Fix', { within: 'section[aria-label="Why these steps"]' });
  const signals = await page.evaluate(`document.querySelector('section[aria-label="Why these steps"] [aria-label="Why Fix"]')?.innerText ?? ''`);
  ev.check('the "Fix" chip opens its signals as sentences', signals.length > 0 && signals.includes('→'), signals);
  await shot(c, ev, 'why-these-steps');

  const tasks = await c.tasks(id);
  const agentSteps = Object.values(tasks).filter((t) => t.executor !== 'ship');
  ev.check('one agent step, then the ship step', agentSteps.length === 1 && Object.values(tasks).some((t) => t.executor === 'ship'), Object.values(tasks).map((t) => `${t.key}:${t.executor}`));

  let sawOpening = null;
  const shipped = await until(async () => {
    const view = await ship(c, id);
    if (view.stage === 'opening') sawOpening = view;
    return view.prs.length > 0 && view;
  }, { label: 'ship opened', timeoutMs: 120_000 });
  if (sawOpening !== null) ev.note(`saw the ship step opening: ${sawOpening.status}`);
  ev.check(`GET /ship: one pull request opened on ${REPO}`, shipped.prs.length === 1 && shipped.prs[0].repo === REPO && shipped.prs[0].state === 'opened', shipped);
  // With no CI on this repository the ship step goes straight on to its decision.
  const card = await shipCardText(c, id, (t) => t.includes('Open in GitHub'));
  ev.check('ship card shows the pull request with Open in GitHub', card.includes('Open in GitHub') && card.includes(`${REPO} #${shipped.prs[0].number}`), card);
  await shot(c, ev, 'ship-card');

  const created = ghCalls().filter((x) => x.args[0] === 'pr' && x.args[1] === 'create');
  ev.check('fake gh saw `pr create` without --draft', created.length === 1 && !created[0].args.includes('--draft'), created.map((x) => x.args.join(' ')));
  const pr = prs().find((p) => p.number === shipped.prs[0].number);
  ev.check('the pull request is not a draft and is titled from the profile', pr !== undefined && pr.isDraft === false && pr.title.startsWith('fix:'), pr && { title: pr.title, isDraft: pr.isDraft });
  const done = await waitStatus(c, id, ['COMPLETE', 'EXECUTING'], 30_000);
  ev.note(`mission ends ${done}`);
  void api;
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
}
c.close(); ev.save();
