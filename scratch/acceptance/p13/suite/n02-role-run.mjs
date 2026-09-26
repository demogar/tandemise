// N2 — Attach tdd to the Developer role in Team → Roles, then run the "P13 skills" workflow, whose implement step
// also pins house-style@latest. The scripted runtime reads .claude/skills like Claude Code: the run's worktree
// holds both skills, the agent's handoff names them, the drawer shows name, version and hash, and nothing of
// .claude/skills is committed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { cleanSlate, clickRow, closeDrawer, drawerSkills, openRole, openSkills, readState, records, runSkills, saveRole, sectionText, settle, waitRow, writeState } from '../common.mjs';

const c = await context();
const { page, sleep } = c;
const ev = new Evidence('N2', 'A role pins a skill; the run gets it in its worktree, recorded by version and hash, never committed');
await cleanSlate(c, ev);
const { hashes } = readState().n1;

const before = await openRole(c, 'Developer');
ev.check('Team → Roles → Developer has a Skills section with none attached', before.includes('No skills attached'), before);
await page.select('Attach a skill', 'tdd (v1)');
await page.click('Attach');
const attached = await sectionText(c, 'Skills');
ev.check('after Attach: "tdd v1"', attached.includes('tdd v1'), attached);
await page.evaluate(`document.querySelector('section[aria-label="Skills"]').scrollIntoView({ block: 'center' })`);
await sleep(300);
await page.screenshot(ev.shot('developer-skills'));
await saveRole(c);
const role = (await c.api.get(`/v1/roles?workspaceId=${c.env.workspaceId}`)).find((r) => r.id === 'development');
ev.check('proof (API): the Developer role pins tdd v1', JSON.stringify(role?.skills) === JSON.stringify([{ name: 'tdd', version: 1 }]), role?.skills);

const run = Date.now().toString(36);
const goal = `N2 hello page ${run}`;
const id = await c.createMission(goal, { workflow: 'P13 skills' });
const title = (await c.api.get(`/v1/missions/${id}`)).mission.title;
await c.approvePlan(id, title);
const status = await settle(c, id);
ev.check('the mission completes', status === 'COMPLETE', status);

const impl = await drawerSkills(c, id, 'Implement');
const expected = `Skills: tdd v1 · ${hashes.tdd.slice(0, 12)}, house-style v1 · ${hashes['house-style'].slice(0, 12)}`;
ev.check(`implement drawer: "${expected}"`, impl.skills === expected, impl.skills);
ev.check('its gate read skills.loaded and skills.missing', impl.text.includes('skills.loaded') && impl.text.includes('skills.missing'), impl.text.slice(0, 900));
await page.screenshot(ev.shot('implement-drawer'));
await closeDrawer(c);
const review = await drawerSkills(c, id, 'Review');
ev.check('the review step pins none: no Skills line', review.skills === '', review.skills);
await closeDrawer(c);

await page.navigate(`#/missions/${id}`);
const feed = await c.until(async () => { const t = await page.text('main'); return t.includes('Skills folder:') && t; }, { label: 'handoff with skills', timeoutMs: 20_000 });
ev.check('the agent\'s handoff (feed) says "Skills folder: house-style, tdd"', feed.includes('Skills folder: house-style, tdd') && feed.includes('Skills in prompt: none'), feed.slice(0, 1200));

const rec = records(goal).find((r) => r.title.includes('Implement') || r.skills.folder.length > 0);
const cwd = rec?.skills?.cwd;
ev.check('proof (agent record): it found house-style and tdd in .claude/skills', JSON.stringify(rec?.skills?.folder) === '["house-style","tdd"]', rec?.skills);
ev.check('proof (disk): the worktree holds .claude/skills/tdd/SKILL.md and reference.md', cwd !== undefined && existsSync(`${cwd}/.claude/skills/tdd/SKILL.md`) && existsSync(`${cwd}/.claude/skills/tdd/reference.md`), cwd);
const exclude = cwd === undefined ? '' : readFileSync(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { cwd }).toString().trim(), 'utf8');
ev.check('proof (git): info/exclude lists /.claude/skills/tdd/ and /.claude/skills/house-style/', exclude.includes('/.claude/skills/tdd/') && exclude.includes('/.claude/skills/house-style/'), exclude);
const committed = cwd === undefined ? '' : execFileSync('git', ['log', '--name-only', '--format=', '-n', '10'], { cwd }).toString();
ev.check('proof (git): no commit on the branch contains .claude', !committed.includes('.claude'), committed);
ev.check('proof (disk): the project checkout itself got nothing', !existsSync(`${c.env.project}/.claude`));
const runs = runSkills(c, id);
ev.check('proof (SQL): runs.skills records name, version, hash and via', JSON.stringify(runs.find((r) => r.key === 'implement')?.skills) === JSON.stringify([
  { name: 'tdd', version: 1, hash: hashes.tdd, via: 'folder' }, { name: 'house-style', version: 1, hash: hashes['house-style'], via: 'folder' },
]), runs);

await openSkills(c);
const tdd = await waitRow(c, 'tdd', (t) => t.includes('Used by Developer v1'), 'Used by Developer v1');
ev.check('Skills → tdd reads "Used by Developer v1"', tdd.text.includes('Used by Developer v1'), tdd.text);
await clickRow(c, 'tdd');
const usedBy = await sectionText(c, 'Used by');
ev.check('its detail says "Developer pins v1"', usedBy.includes('Developer pins v1'), usedBy);

writeState({ n2: { id, implHashes: hashes } });
c.close(); ev.save();
