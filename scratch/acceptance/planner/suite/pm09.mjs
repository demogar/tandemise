import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { context, SCRATCH } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { readState, setRepo } from '../../../fake-gh.mjs';
import { REPO, autoDraft, ghCalls, headerAction, openMission, prs, ship, shipCardText, shot, waitStatus } from '../common.mjs';

const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('PM9', 'Revert undoes an auto-merge through its own pull request');
const merges = () => ghCalls().filter((x) => x.args[0] === 'pr' && x.args[1] === 'merge');
const comments = (n) => readState(`${SCRATCH}/gh`).repos[REPO].comments[String(n)] ?? [];
const factoryDir = join(SCRATCH, 'project', '.tandemise', 'factory');
void readFileSync; void existsSync; void writeFileSync; void setRepo; void sleep; void api; void prs; void merges; void comments; void factoryDir;

try {
  const original = readFileSync(join(SCRATCH, 'pm04-mission'), 'utf8').trim();
  const before = await ship(c, original);
  await shipCardText(c, original, (t) => t.includes('Revert'));
  await page.click('Revert', { within: '[role=dialog] section[aria-label="Pull request"]' });
  const revert = await until(async () => { const r = c.sql("SELECT id, status FROM missions WHERE title LIKE 'revert: %' ORDER BY created_at DESC"); return r[0] && r[0].status === 'COMPLETE' && r[0]; }, { label: 'revert merged', timeoutMs: 240_000 });
  ev.check('Revert opened a revert mission that completed', revert.status === 'COMPLETE', revert);
  const rv = await ship(c, revert.id);
  ev.check('…its pull request "revert: …" merged on its own', rv.headline === 'Merged on its own' && rv.prs[0] !== undefined, rv);
  const pr = readState(`${SCRATCH}/gh`).repos[REPO].prs.find((p) => p.number === rv.prs[0].number);
  ev.check('…titled revert: fix: typo in the about title', pr?.title === 'revert: fix: typo in the about title' && pr.state === 'MERGED', pr && [pr.title, pr.state]);
  const events = await c.events(original);
  ev.check("the original mission's history shows the revert", events.some((e) => e.body?.type === 'merge.reverted') && events.some((e) => e.body?.type === 'merge.merged'), events.filter((e) => String(e.body?.type).startsWith('merge.')).map((e) => e.body.type));
  void before;
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
}
c.close(); ev.save();
