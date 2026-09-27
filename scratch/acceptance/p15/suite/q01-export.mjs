// Q1 — Export: the Developer's model is set in Team → Roles and the project has a monthly limit; Project → Setup as
// code → Export writes .tandemise/ in the acceptance project. The section lists the files and the content hash and
// says "Last exported <hash>"; the files on disk hold the model, the limit, the routines and the workflows; a second
// export writes the same bytes (same hash); git does not ignore them.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { exportInWindow, openSetup, readSetupFile, setRoleModels, setupDir, setupText, writeState, docsSize } from '../common.mjs';

const c = await context();
const { page } = c;
await docsSize(c);
const ev = new Evidence('Q1', 'Export writes the setup to .tandemise/, byte-stable, with the hash in the window');

await setRoleModels(c, 'Developer', { model: 'base-model', escalate: 'strong-model' });
// Setup shortcuts (P8/P11 screens are proven by their own suites): a monthly limit, a WIP limit and one routine.
await c.api.patch(`/v1/workspaces/${c.env.workspaceId}`, { monthlyLimits: [{ metric: 'agent_minutes', amount: 600, warnPercent: 80 }], maxActiveMissions: 2 });
await c.api.post(`/v1/workspaces/${c.env.workspaceId}/routines`, {
  name: 'Weekly dependency bump', kind: 'mission', goal: 'Update the dependencies ({date})', successCriteria: ['Every dependency is current'],
  priority: 'normal', schedule: { type: 'weekly', day: 1, at: '09:00' },
});
ev.note('setup (API): monthly limit 600 agent minutes, WIP limit 2, one weekly routine');

await openSetup(c);
const before = await setupText(c);
ev.check('the section says it has not been exported yet', before.includes('Setup as code') && before.includes('Not exported yet'), before.slice(0, 200));
await page.screenshot(ev.shot('before-export'));

const first = await exportInWindow(c);
ev.check('the window lists the files written and the content hash', first.text.includes('.tandemise/tandemise.yaml') && first.text.includes('.tandemise/roles/development.md') && first.text.includes('.tandemise/routines.yaml') && first.text.includes(`Content hash ${first.hash}`), first.text.slice(0, 800));
ev.check('workflows already in this repository are left as they are', first.text.includes('.tandemise/workflows/p0.yaml') && first.text.includes('already here, left as it is'));
await c.until(async () => (await setupText(c)).includes(`Last exported ${first.hash}`), { label: 'Last exported', timeoutMs: 10_000 });
ev.check('"Last exported <hash>" in the section header', (await setupText(c)).includes(`Last exported ${first.hash}`));
await page.screenshot(ev.shot('exported'));

const dev = readSetupFile(c, 'roles/development.md');
ev.check('on disk: roles/development.md has the model and the retry model in its front matter', dev.startsWith('---\n') && dev.includes('\nmodel: base-model\n') && dev.includes('escalate:\n  - strong-model'), dev.slice(0, 500));
const main = readSetupFile(c, 'tandemise.yaml');
ev.check('on disk: tandemise.yaml has version, the WIP limit and the monthly limit', main.includes('version: 1') && main.includes('wipLimit: 2') && main.includes('amount: 600'), main);
ev.check('on disk: routines.yaml has the routine and no on/off or history', readSetupFile(c, 'routines.yaml').includes('name: Weekly dependency bump') && !readSetupFile(c, 'routines.yaml').includes('enabled'));
ev.check('on disk: every built-in role has a file', ['product', 'design', 'architecture', 'development', 'review', 'qa', 'release', 'finance'].every((id) => existsSync(join(setupDir(c), 'roles', `${id}.md`))), readdirSync(join(setupDir(c), 'roles')));
const everything = ['tandemise.yaml', 'routines.yaml', ...readdirSync(join(setupDir(c), 'roles')).map((f) => `roles/${f}`)].map((p) => readSetupFile(c, p)).join('\n');
ev.check('no timestamps, row ids or machine paths in the files', !/\d{4}-\d\d-\d\dT\d\d:/.test(everything) && !/\b(wsp|rtn|msn|rpo)_[A-Za-z0-9]/.test(everything) && !everything.includes(c.env.scratch) && !everything.includes('/tmp/'));

const second = await exportInWindow(c);
ev.check('a second export: the same hash', second.hash === first.hash, [first.hash, second.hash]);
const status = spawnSync('git', ['status', '--porcelain', '--', '.tandemise'], { cwd: c.env.project, encoding: 'utf8' }).stdout;
ev.check('proof (git): the exported files show up as new files git will commit', status.includes('?? .tandemise/') || status.includes('.tandemise/tandemise.yaml'), status);
const ignored = spawnSync('git', ['check-ignore', '.tandemise/tandemise.yaml', '.tandemise/roles/development.md'], { cwd: c.env.project });
ev.check('proof (git): none of them is ignored', ignored.status === 1, ignored.stdout?.toString());
const api = await c.api.get(`/v1/workspaces/${c.env.workspaceId}/setup`);
ev.check('proof (API): the last export is remembered', api.lastExport?.hash === first.hash && api.lastExport?.repositoryName === 'acceptance-project', api);

writeState({ q1: { hash: first.hash } });
c.close(); ev.save();
