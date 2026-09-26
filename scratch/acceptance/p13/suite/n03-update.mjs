// N3 — The tdd source folder is edited. Skills shows "Update available"; Update imports v2 (explicitly). The
// Developer role still pins v1 until "Use v2" is chosen in Team → Roles. N2's run still reads v1 with its old
// hash. A new mission, on a runtime that does not read a skills folder, gets v2 appended to its prompt.
import { appendFileSync } from 'node:fs';
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { SCRATCH, cleanSlate, clickRow, closeDrawer, drawerSkills, library, openRole, openSkills, readState, records, runSkills, saveRole, sectionText, setSkillsFolder, settle, waitRow, writeState } from '../common.mjs';

const c = await context();
const { page, sleep, until } = c;
const ev = new Evidence('N3', 'An edited source shows "Update available"; updating and moving the role are explicit; old runs keep their hash');
await cleanSlate(c, ev);
const { hashes } = readState().n1;
const n2 = readState().n2;

appendFileSync(`${SCRATCH}/claude-skills/tdd/SKILL.md`, '4. Commit when the tests are green.\n');
ev.note('edited claude-skills/tdd/SKILL.md on disk (a fourth step)');

await openSkills(c);
const flagged = await waitRow(c, 'tdd', (t) => t.includes('Update available'), 'Update available on tdd', 30_000);
ev.check('the tdd row says "Update available"', flagged.text.includes('Update available'), flagged.text);
const others = (await import('../common.mjs')).libraryRows;
const rows = await others(c);
ev.check('the other skills do not', rows.filter((r) => r.name !== 'tdd').every((r) => !r.text.includes('Update available')), rows);
await clickRow(c, 'tdd');
const source = await sectionText(c, 'Source');
ev.check('its Source says the source changed since v1 and roles keep their version', source.includes('The source changed since v1') && source.includes('roles keep their version'), source);
await page.screenshot(ev.shot('update-available'));
ev.check('proof (API): still one version (nothing was updated by itself)', (await library(c)).find((s) => s.name === 'tdd').versions.length === 1);

await page.click('Update', { within: '[aria-label="Source"]' });
await until(async () => (await sectionText(c, 'Versions')).includes('v2'), { label: 'v2 in Versions', timeoutMs: 15_000 });
const versions = await sectionText(c, 'Versions');
ev.check('Versions now lists v2 and v1', /v2[\s\S]*v1/.test(versions), versions);
const lib = await library(c);
const tdd = lib.find((s) => s.name === 'tdd');
ev.check('proof (API): v2 has a new hash, v1 keeps its own', tdd.latest.version === 2 && tdd.latest.hash !== hashes.tdd && tdd.versions[1].hash === hashes.tdd, tdd.versions.map((v) => [v.version, v.shortHash]));
const usedBy = await sectionText(c, 'Used by');
ev.check('Used by: "Developer pins v1 · v2 is available"', usedBy.includes('Developer pins v1') && usedBy.includes('v2 is available'), usedBy);
await page.screenshot(ev.shot('versions'));

const roleSection = await openRole(c, 'Developer');
ev.check('Team → Roles → Developer still pins tdd v1 and offers "Use v2"', roleSection.includes('tdd v1') && roleSection.includes('Use v2'), roleSection);
await page.click('Use v2', { within: 'section[aria-label="Skills"]' });
await saveRole(c);
ev.check('after Use v2 and Save: "tdd v2"', (await sectionText(c, 'Skills')).includes('tdd v2'));

const old = await drawerSkills(c, n2.id, 'Implement');
ev.check(`N2's implement drawer still reads tdd v1 · ${hashes.tdd.slice(0, 12)}`, old.skills.includes(`tdd v1 · ${hashes.tdd.slice(0, 12)}`), old.skills);
await closeDrawer(c);

await setSkillsFolder(c, false);
ev.note('setup shortcut: the scripted runtime no longer reads .claude/skills (settings.skillsFolder false), so skills go into its prompt');
const run = Date.now().toString(36);
const goal = `N3 hello page ${run}`;
const id = await c.createMission(goal, { workflow: 'P13 skills' });
const title = (await c.api.get(`/v1/missions/${id}`)).mission.title;
await c.approvePlan(id, title);
const status = await settle(c, id);
ev.check('the new mission completes', status === 'COMPLETE', status);
const impl = await drawerSkills(c, id, 'Implement');
const expected = `Skills: tdd v2 · ${tdd.latest.hash.slice(0, 12)} (in prompt), house-style v1 · ${hashes['house-style'].slice(0, 12)} (in prompt)`;
ev.check(`its implement drawer: "${expected}"`, impl.skills === expected, impl.skills);
await page.screenshot(ev.shot('drawer-v2-in-prompt'));
await closeDrawer(c);
await page.navigate(`#/missions/${id}`);
const feed = await until(async () => { const t = await page.text('main'); return t.includes('Skills in prompt:') && t; }, { label: 'handoff with skills', timeoutMs: 20_000 });
ev.check('the agent\'s handoff says "Skills in prompt: house-style, tdd" and no folder', feed.includes('Skills in prompt: house-style, tdd') && feed.includes('Skills folder: none'), feed.slice(0, 1200));
const prompt = c.prompts().filter((p) => p.includes(goal) && p.includes('### Skill: tdd (v2)')).pop() ?? '';
ev.check('proof (prompt): "## Skills pinned to this step" with the v2 SKILL.md', prompt.includes('## Skills pinned to this step') && prompt.includes('4. Commit when the tests are green.'), prompt.slice(prompt.indexOf('## Skills pinned')).slice(0, 600));
const rec = records(goal)[0];
ev.check('proof (agent record): prompt [house-style, tdd], folder []', JSON.stringify(rec?.skills?.prompt) === '["house-style","tdd"]' && JSON.stringify(rec?.skills?.folder) === '[]', rec?.skills);
ev.check('proof (SQL): N2\'s run still records tdd v1 with its old hash', runSkills(c, n2.id).find((r) => r.key === 'implement')?.skills?.[0]?.hash === hashes.tdd);

await setSkillsFolder(c, true);
writeState({ n3: { id, tddV2: tdd.latest.hash } });
c.close(); ev.save();
