// E4 — A spend cap of $0.60 at $0.25 a run. The same Models candidate as E2, 2 repeats, started in the
// window with the cap at 0.60: a bad-model baseline trial alone runs twice ($0.50), so the run crosses the
// cap part way through and stops, and the window says "Stopped at your $0.60 cap".
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { docsSize, evalRun, readState, runsHash, waitRun, windowOf, writeState } from '../common.mjs';

const c = await context();
const { page, until } = c;
await docsSize(c);
const { go, press, has, waitFor } = windowOf(c);
const ev = new Evidence('E4', 'A $0.60 spend cap at $0.25 a run stops the run');
const { e1 } = readState();
if (!e1?.suiteId) throw new Error('E4 needs E1 first (the suite)');

await go(runsHash(e1.suiteId));
await press('New run');
await waitFor('Start run');
await press('Models', '[aria-label="Candidate kind"]');
await page.fill('Model for Developer', 'good');
await page.fill('Repeats', '2');
await page.fill('Spend cap', '0.6');
await page.screenshot(ev.shot('run-form'));
await press('Start run');
const runId = await until(async () => { const id = new URLSearchParams(await page.evaluate('location.search')).get('run'); return id && id !== readState().e2?.runId && id; }, { label: 'the run opens', timeoutMs: 20_000 });
const started = await evalRun(c, runId);
ev.check('proof (API): the run has a $0.60 cap, 2 repeats, Developer on "good"', started.spendCapUsd === 0.6 && started.repeats === 2 && started.candidate.roles?.development === 'good', { cap: started.spendCapUsd, repeats: started.repeats, candidate: started.candidate });

const done = await waitRun(c, runId);
ev.check('proof (API): the run stopped at its cap', done.status === 'stopped_at_cap', { status: done.status, reason: done.reason });
ev.check('proof (API): its reason is "Stopped at your $0.60 cap"', done.reason === 'Stopped at your $0.60 cap', done.reason);
ev.check('proof (API): it spent at least the cap, measured, and the trials not yet run were cancelled', done.spentUsd !== null && done.spentUsd >= 0.6 && done.trials.some((t) => t.status === 'cancelled'), { spentUsd: done.spentUsd, progress: done.progress, trials: done.trials.map((t) => `${t.variant} ${t.repeat} ${t.status}`) });

await go(runsHash(e1.suiteId, runId));
await waitFor('Stopped at');
const status = await page.evaluate(`document.querySelector('main [aria-label="Status"]')?.innerText ?? ''`);
ev.check('the window shows "Stopped at your $0.60 cap"', status.includes('Stopped at your $0.60 cap') && (await has('Stopped at your $0.60 cap')), status);
const spend = await page.evaluate(`document.querySelector('[aria-label="Spend"]')?.innerText ?? ''`);
ev.check('the spend reads "Spent $… of $0.60"', /Spent \$[0-9.]+ of \$0\.60/.test(spend), spend);
const badge = await page.evaluate(`document.querySelector('main [aria-label="Run"] .reader__meta')?.innerText ?? ''`);
ev.note(`run header: ${JSON.stringify(badge)}`);
await page.screenshot(ev.shot('stopped-at-cap'));

writeState({ e4: { runId } });
c.close(); ev.save();
