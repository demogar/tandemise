import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { context, SCRATCH } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { readState, setRepo } from '../../../fake-gh.mjs';
import { REPO, autoDraft, ghCalls, headerAction, openMission, prs, ship, shipCardText, shot, waitStatus } from '../common.mjs';

const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('PM3', 'Turning auto-merge on shows the backtest first and records a Decision');
const merges = () => ghCalls().filter((x) => x.args[0] === 'pr' && x.args[1] === 'merge');
const comments = (n) => readState(`${SCRATCH}/gh`).repos[REPO].comments[String(n)] ?? [];
const factoryDir = join(SCRATCH, 'project', '.tandemise', 'factory');
void readFileSync; void existsSync; void writeFileSync; void setRepo; void sleep; void api; void prs; void merges; void comments; void factoryDir;

try {
  await page.navigate('#/project');
  await until(() => page.evaluate(`Boolean(document.querySelector('section[aria-label="Merge"]'))`), { label: 'merge section', timeoutMs: 30_000 });
  await page.evaluate(`document.querySelector('section[aria-label="Merge"]').scrollIntoView({ block: 'start' })`);
  await page.click('Turn auto-merge on…', { within: 'section[aria-label="Merge"]' });
  const preview = await until(async () => { const t = await page.evaluate(`document.querySelector('section[aria-label="Merge"]')?.innerText ?? ''`); return t.includes('Over the last 90 days') && t; }, { label: 'backtest', timeoutMs: 20_000 });
  ev.check('the backtest is shown before saving: "Over the last 90 days this would have merged …"', /Over the last 90 days this would have merged \d+ of \d+ pull requests on its own/.test(preview), preview);
  const before = existsSync(join(factoryDir, 'merge.yaml')) ? readFileSync(join(factoryDir, 'merge.yaml'), 'utf8') : '';
  ev.check('…and nothing is written yet', !/autoMerge: on/.test(before), before.slice(0, 200));
  await shot(c, ev, 'backtest');
  await page.click('Turn it on', { within: 'section[aria-label="Merge"]' });
  const after = await until(async () => { const t = existsSync(join(factoryDir, 'merge.yaml')) ? readFileSync(join(factoryDir, 'merge.yaml'), 'utf8') : ''; return /autoMerge: on/.test(t) && t; }, { label: 'merge.yaml on', timeoutMs: 20_000 });
  ev.check("the repository's .tandemise/factory/merge.yaml says autoMerge: on", /autoMerge: on/.test(after), after.slice(0, 200));
  const decisions = c.sql("SELECT title, status FROM decisions WHERE workspace_id = ?", c.env.workspaceId);
  ev.check('a Decision records it: "Auto-merge low-risk pull requests in …"', decisions.some((d) => d.title.startsWith('Auto-merge low-risk pull requests in') && d.status === 'accepted'), decisions);
  const text = await until(async () => { const t = await page.evaluate(`document.querySelector('section[aria-label="Merge"]')?.innerText ?? ''`); return t.includes('Auto-merge is on') && t; }, { label: 'switch on', timeoutMs: 20_000 });
  ev.check('the Merge section says auto-merge is on, with Stop auto-merging', text.includes('Stop auto-merging'), text);
  await shot(c, ev, 'on');
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
}
c.close(); ev.save();
