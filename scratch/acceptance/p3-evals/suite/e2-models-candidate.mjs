// E2 — With the Developer role on "bad", a run on E1's suite with the Models candidate "good" and 3 repeats,
// started in the window. Its progress shows while it runs, then the scorecard reads Baseline 0%, Candidate
// 100%, +100 points on the gate pass rate. The trials are real missions, but the Missions list, the Desk and
// the Inbox never show one.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { developerOn, docsSize, evalRun, readState, role, runsHash, waitRun, windowOf, writeState } from '../common.mjs';

const c = await context();
const { page, api, env, until, sleep } = c;
await docsSize(c);
const { go, press, has, waitFor, reload, scoreRow } = windowOf(c);
const ev = new Evidence('E2', 'A Models candidate against the role on "bad": progress, then a +100 point scorecard; no trial shows anywhere');
const { e1 } = readState();
if (!e1?.suiteId) throw new Error('E2 needs E1 first (the suite and its case)');

await developerOn(c, 'bad');
ev.check('proof (API): the Developer role is on "bad" now', (await role(c)).models?.model === 'bad', (await role(c)).models);
await reload();

// ------------------------------------------------------------------ the run form, in the window
await go(runsHash(e1.suiteId));
await waitFor('Start run');
ev.check('a suite with no runs opens the new-run form, on Models, prefilled with the role\'s model "bad"',
  await page.evaluate(`document.querySelector('input[aria-label="Model for Developer"]')?.value === 'bad'`),
  await page.evaluate(`document.querySelector('input[aria-label="Model for Developer"]')?.value ?? null`));
// Left as the role has it today, the candidate would change nothing: refused inline, and no run starts.
await press('Start run');
await sleep(500);
const unchanged = await page.evaluate(`document.querySelector('main [aria-label="New run"] [role=alert]')?.innerText ?? ''`);
ev.check('starting with every role as it is today is refused: "This candidate changes nothing."', unchanged === 'This candidate changes nothing.' && (await api.get(`/v1/evals/suites/${e1.suiteId}/runs`)).length === 0, unchanged);
await page.fill('Model for Developer', 'good');
await page.fill('Repeats', '3');
await page.fill('Spend cap', '10');
await page.screenshot(ev.shot('run-form'));
await press('Start run');
const runId = await until(async () => new URLSearchParams(await page.evaluate('location.search')).get('run'), { label: 'the run opens', timeoutMs: 20_000 });
const started = await evalRun(c, runId);
ev.check('proof (API): the run is Models → Developer on "good", 3 repeats, cap $10', started.candidate.kind === 'models' && started.candidate.roles.development === 'good' && started.repeats === 3 && started.spendCapUsd === 10, { candidate: started.candidate, repeats: started.repeats, cap: started.spendCapUsd });

// ------------------------------------------------------------------ progress, while it runs
await waitFor('Cancel run');
await until(async () => (await evalRun(c, runId)).progress.done >= 1, { label: 'a trial finishes', timeoutMs: 120_000, everyMs: 500 });
await sleep(2500);
const progress = await page.evaluate(`document.querySelector('[aria-label="Progress"]')?.innerText ?? ''`);
const live = await evalRun(c, runId);
ev.check('while it runs, the window shows "n / 6 trials" and "Cancel run"', /\b\d \/ 6 trials/.test(progress) && (await has('Cancel run')) && ['queued', 'running'].includes(live.status), { progress, status: live.status });
ev.check('the spend shows against the cap: "Spent $… of $10.00"', /Spent \$[0-9.]+ of \$10\.00/.test(await page.text('main')), await page.evaluate(`document.querySelector('[aria-label="Spend"]')?.innerText ?? ''`));
await page.screenshot(ev.shot('running'));

// ------------------------------------------------------------------ no trial anywhere, while trials exist
const trialMissions = () => c.sql("SELECT id, title, status FROM missions WHERE eval_trial_id IS NOT NULL AND workspace_id = ?", env.workspaceId);
const during = trialMissions();
ev.check('proof (SQL): the trials are real missions ("Eval trial …")', during.length >= 1 && during.every((m) => m.title.startsWith('Eval trial')), during);
const hidden = async (when) => {
  const ids = trialMissions().map((m) => m.id);
  const listed = await api.get(`/v1/missions?workspaceId=${env.workspaceId}`);
  const missions = (Array.isArray(listed) ? listed : listed.missions ?? listed.items ?? []).map((m) => m.mission ?? m);
  const home = JSON.stringify(await api.get(`/v1/home?workspaceId=${env.workspaceId}`));
  const inbox = JSON.stringify(await api.get(`/v1/inbox?workspaceId=${env.workspaceId}`));
  const approvals = (await api.get(`/v1/approvals?workspaceId=${env.workspaceId}`).catch(() => [])).map((a) => a.approval ?? a);
  ev.check(`proof (API, ${when}): the mission list, Home, the Inbox and approvals name no trial mission`,
    ids.length > 0 && !missions.some((m) => ids.includes(m.id)) && !ids.some((id) => home.includes(id) || inbox.includes(id)) && !approvals.some((a) => ids.includes(a.missionId)) && !/Eval trial/.test(home + inbox),
    { trials: ids.length, listed: missions.map((m) => m.title) });

  await go('#/missions');
  await waitFor('All');
  // The list opens on Active; "All" shows every mission, finished ones too.
  await until(() => page.evaluate(`(() => { const b = [...document.querySelectorAll('main button, main [role=tab]')].find((x) => x.offsetParent !== null && x.innerText.trim().split(/\\s+/)[0] === 'All'); if (!b) return false; b.click(); return true; })()`), { label: 'the All filter', timeoutMs: 20_000 });
  await waitFor(e1.goal);
  const list = await page.text('main');
  const all = Number(/\bAll\s+(\d+)/.exec(list)?.[1] ?? NaN);
  ev.check(`the Missions list (${when}, All) shows E1's mission, counts 1 mission, and no "Eval trial"`, list.includes(e1.goal) && all === 1 && !list.includes('Eval trial'), list.slice(0, 700));
  await page.screenshot(ev.shot(`missions-${when}`));
  await go('#/');
  await until(() => page.evaluate(`!!document.querySelector('section[aria-label="Desk"]')`), { label: 'the Desk', timeoutMs: 20_000 });
  await sleep(800);
  const desk = await page.text('main');
  ev.check(`the Desk (${when}) shows no "Eval trial"`, !desk.includes('Eval trial'), desk.slice(0, 500));
  await page.screenshot(ev.shot(`desk-${when}`));
  await go('#/inbox');
  await sleep(1500);
  const inboxText = await page.text('main');
  ev.check(`the Inbox (${when}) shows no "Eval trial"`, !inboxText.includes('Eval trial'), inboxText.slice(0, 500));
  await page.screenshot(ev.shot(`inbox-${when}`));
};
await hidden('during');

// ------------------------------------------------------------------ the scorecard
const done = await waitRun(c, runId);
ev.check('proof (API): the run completed, 6 of 6 trials', done.status === 'completed' && done.progress.done === 6 && done.progress.total === 6, { status: done.status, progress: done.progress, reason: done.reason });
const sc = done.scorecard;
ev.check('proof (API): gate pass rate baseline 0, candidate 1, difference +1', sc?.baseline.gatePassRate === 0 && sc?.candidate.gatePassRate === 1 && sc?.difference.gatePassRate === 1,
  sc && { baseline: sc.baseline.gatePassRate, candidate: sc.candidate.gatePassRate, difference: sc.difference.gatePassRate, trials: { baseline: sc.baseline.trials, candidate: sc.candidate.trials } });
await go(runsHash(e1.suiteId, runId));
await waitFor('Scorecard');
const gate = await scoreRow('Gate pass rate');
ev.check('the scorecard reads Gate pass rate: Baseline 0%, Candidate 100%, Difference +100 pts', gate[1] === '0%' && gate[2] === '100%' && gate[3] === '+100 pts', gate);
ev.check('the difference is marked better (the success colour)', await page.evaluate(`document.querySelector('[aria-label="Whole suite"] tr[aria-label="Gate pass rate"] td:last-child')?.dataset.direction === 'better'`));
const first = await scoreRow('First-attempt pass rate');
const trials = await scoreRow('Trials');
const cost = await scoreRow('Cost (mean, total)');
ev.note(`Trials ${JSON.stringify(trials)}; First-attempt ${JSON.stringify(first)}; Cost ${JSON.stringify(cost)}`);
ev.check('the Trials row reads Baseline "3 ran · 0 passed · 3 failed · 0 blocked", Candidate "3 ran · 3 passed · 0 failed · 0 blocked"',
  trials[1] === '3 ran · 0 passed · 3 failed · 0 blocked' && trials[2] === '3 ran · 3 passed · 0 failed · 0 blocked', trials);
const heading = await page.evaluate(`document.querySelector('main [aria-label="Candidate"] h2')?.innerText ?? ''`);
ev.check('the candidate heading reads "Candidate, against the setup when this run started"', heading === 'Candidate, against the setup when this run started', heading);
ev.check('no few-repeats note at 3 repeats', !(await has('few repeats, differences may be noise')));
await page.screenshot(ev.shot('scorecard'));
await hidden('after');

writeState({ e2: { runId } });
c.close(); ev.save();
