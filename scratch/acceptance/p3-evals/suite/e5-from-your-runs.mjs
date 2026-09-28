// E5 — From your runs: a role × model row with its first-attempt pass rate and cost, from the real
// mission of E1 (the Developer on "good": one run, passed first time, $0.25). The eval trials of E2 and E4
// ran real missions too, on "bad" and "good", but never count here.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { docsSize, readState, windowOf } from '../common.mjs';

const c = await context();
const { page, api, env, until } = c;
await docsSize(c);
const { go, waitFor } = windowOf(c);
const ev = new Evidence('E5', 'From your runs: role × model rows from the real missions');
const { e1 } = readState();
if (!e1?.missionId) throw new Error('E5 needs E1 first (its mission)');

const summary = await api.get(`/v1/workspaces/${env.workspaceId}/evals/run-scores?days=30`);
ev.note(`API summary: ${JSON.stringify(summary)}`);
const good = summary.find((r) => r.roleId === 'development' && r.model === 'good');
ev.check('proof (API): Developer on "good" — 1 run, first-attempt pass rate 1, median cost $0.25', good?.runs === 1 && good?.firstAttemptPassRate === 1 && good?.medianCostUsd === 0.25, good);
ev.check('proof (API): no Developer on "bad" row (every "bad" run was an eval trial)', !summary.some((r) => r.roleId === 'development' && r.model === 'bad'), summary.map((r) => `${r.roleId}/${r.model}`));
const scored = c.sql('SELECT COUNT(*) AS n FROM run_scores WHERE eval_trial = 1')[0]?.n ?? 0;
ev.check('proof (SQL): trials were scored too, but kept out of this summary', scored > 0, { trialScores: scored });

await go('#/evals?tab=yours');
await waitFor('Every gated step');
await until(() => page.evaluate(`!!document.querySelector('main table[aria-label="From your runs"]')`), { label: 'the runs table', timeoutMs: 20_000 });
const cells = await page.evaluate(`[...(document.querySelector('tr[aria-label="Developer on good"]')?.querySelectorAll('td') ?? [])].map((td) => td.innerText.trim())`);
const heads = await page.evaluate(`[...document.querySelectorAll('main table[aria-label="From your runs"] th')].map((th) => th.innerText.trim())`);
ev.note(`columns: ${JSON.stringify(heads)}`);
ev.check('the window has a "Developer on good" row: 1 run, First-attempt pass 100%, Median cost $0.25', cells[0] === 'Developer' && cells[1] === 'good' && cells[2] === '1' && cells[3] === '100%' && cells[6] === '$0.25', cells);
ev.check('no "Developer on bad" row in the window', !(await page.evaluate(`!!document.querySelector('tr[aria-label="Developer on bad"]')`)));
const rows = await page.evaluate(`[...document.querySelectorAll('main table[aria-label="From your runs"] tbody tr')].map((tr) => tr.getAttribute('aria-label'))`);
ev.note(`rows: ${JSON.stringify(rows)}`);
await page.screenshot(ev.shot('from-your-runs'));

c.close(); ev.save();
