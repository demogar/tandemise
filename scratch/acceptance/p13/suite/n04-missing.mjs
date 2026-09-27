// N4 — A missing skill refuses the run by name. The "P13 lint" workflow's second step pins lint-rules@1. While
// the first step runs, lint-rules is deleted on the Skills screen. The second step is refused before it runs:
// the Inbox card names the skill and its version. Importing the same folder again brings the same content back;
// Retry on the card runs the step and the mission completes.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { SCRATCH, cleanSlate, clickRow, closeDrawer, drawerSkills, importFolder, libraryRows, openSkills, readState, runSkills, settle } from '../common.mjs';

const c = await context();
const { page, sleep, until } = c;
const ev = new Evidence('N4', 'A pinned skill that is missing refuses the run with its name; re-import and Retry finish it');
await cleanSlate(c, ev);
const { hashes } = readState().n1;

const run = Date.now().toString(36);
const goal = `N4 lint ${run} SCRIPTED_SLOW_20S`;
const id = await c.createMission(goal, { workflow: 'P13 lint' });
const title = (await c.api.get(`/v1/missions/${id}`)).mission.title;
await c.approvePlan(id, title);
const pinned = (await c.task(id, 'check_lint'))?.skills;
ev.check('proof (API): Check lint pinned lint-rules v1 when the plan was made', JSON.stringify(pinned) === JSON.stringify([{ name: 'lint-rules', version: 1, hash: hashes['lint-rules'], from: 'step' }]), pinned);

await openSkills(c);
await clickRow(c, 'lint-rules');
await page.click('Delete', { within: '[aria-label="Source"]' });
await until(async () => (await c.dialogText('Delete “lint-rules”?')) !== '', { label: 'confirm', timeoutMs: 10_000 });
await page.click('Delete skill', { within: '[role=dialog]' });
await until(async () => !(await libraryRows(c)).some((r) => r.name === 'lint-rules'), { label: 'lint-rules gone', timeoutMs: 15_000 });
ev.check('lint-rules is gone from the Library', !(await libraryRows(c)).some((r) => r.name === 'lint-rules'));

await until(async () => (await c.task(id, 'check_lint'))?.status === 'BLOCKED', { label: 'check_lint blocked', timeoutMs: 120_000 });
const blocked = await c.task(id, 'check_lint');
ev.check('Check lint is BLOCKED with the skill named', /^Skill 'lint-rules' v1 \([0-9a-f]{12}\) is missing from the skills library\. Import it again on the Skills screen, then choose Retry\.$/.test(blocked.statusReason ?? ''), blocked.statusReason);
ev.check('proof (SQL): no run was started for it', runSkills(c, id).every((r) => r.key !== 'check_lint'), runSkills(c, id));

await c.ui.inbox('Everyone');
const inbox = await until(async () => { const t = await page.text('main'); return t.includes('needs a skill that is missing') && t; }, { label: 'inbox card', timeoutMs: 20_000 });
ev.check('Inbox: "‘Check lint’ needs a skill that is missing"', inbox.includes('‘Check lint’ needs a skill that is missing'), inbox.slice(0, 800));
await c.ui.openItem('‘Check lint’ needs a skill that is missing');
const card = await page.text('main');
ev.check('the card names lint-rules v1 and says what to do', card.includes("Skill 'lint-rules' v1") && card.includes('Import it again on the Skills screen') && card.includes('Retry') && card.includes('Leave blocked'), card.slice(0, 1500));
await page.screenshot(ev.shot('refused-card'));

await openSkills(c);
const preview = await importFolder(c, `${SCRATCH}/more-skills/lint-rules`);
ev.check('importing the same folder again: "New skill" with the same hash', preview.includes('New skill') && preview.includes(hashes['lint-rules'].slice(0, 12)), preview);

await c.decideInInbox('‘Check lint’ needs a skill that is missing', { option: 'Retry' });
const status = await settle(c, id);
ev.check('after Retry the mission completes', status === 'COMPLETE', status);
const drawer = await drawerSkills(c, id, 'Check lint');
ev.check(`Check lint's drawer: "Skills: lint-rules v1 · ${hashes['lint-rules'].slice(0, 12)} (in prompt)" or as a folder`, drawer.skills.startsWith(`Skills: lint-rules v1 · ${hashes['lint-rules'].slice(0, 12)}`), drawer.skills);
await page.screenshot(ev.shot('after-retry'));
await closeDrawer(c);
const after = runSkills(c, id).filter((r) => r.key === 'check_lint');
ev.check('proof (SQL): one run of Check lint, with lint-rules v1 and its hash', after.length === 1 && after[0].skills?.[0]?.hash === hashes['lint-rules'], after);

c.close(); ev.save();
