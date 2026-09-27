// Q5 — Skills travel with the setup: a skill imported from a folder and pinned to the QA role is exported as
// skills.lock (name, version, hash, source; never its files) and in roles/qa.md. Imported into a second project on
// a home whose skills store lacks those files, the preview shows "Needs import: house-style from <folder>" and never
// takes it (nor the QA role that pins it). "Fetch house-style from its source…" shows the Skills screen's preview;
// importing it and reading the folder again makes the skill Same and the role takeable; Apply pins it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { context, SCRATCH } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import {
  applyInWindow, clickInSetup, docsSize, exportInWindow, previewInWindow, previewRow, readSetupFile, roleOf, setupText, showProject, writeState,
} from '../common.mjs';

const c = await context();
const { page } = c;
await docsSize(c);
const ev = new Evidence('Q5', 'Skill pins export as skills.lock; a missing skill shows "Needs import", is fetched with a preview, then applies');
const ws = c.env.workspaceId;

// ---- setup (API): a skill from a folder, pinned to QA, and issue settings for Q6.
const src = join(SCRATCH, 'skill-src', 'house-style');
mkdirSync(src, { recursive: true });
const BODY = 'Name things after what they do. Keep functions short.';
writeFileSync(join(src, 'SKILL.md'), `---\nname: house-style\ndescription: How we name and shape code.\n---\n\n${BODY}\n`);
const source = { kind: 'path', path: src };
const pv = await c.api.post(`/v1/workspaces/${ws}/skills/preview`, { source });
const imported = await c.api.post(`/v1/workspaces/${ws}/skills`, { source, hash: pv.hash });
const qa = await roleOf(c, 'qa');
const putQa = (workspaceId, role, skills) => c.api.put('/v1/roles/qa', {
  workspaceId, id: 'qa', name: role.name, summary: role.summary, instructions: role.instructions, defaultCapabilities: role.defaultCapabilities,
  producesArtifacts: role.producesArtifacts, consumesArtifacts: role.consumesArtifacts, defaultIsolation: role.defaultIsolation,
  outputContract: role.outputContract, skills,
});
await putQa(ws, qa, [{ name: 'house-style', version: 1 }]);
const repoA = (await c.api.get(`/v1/workspaces/${ws}/repositories`))[0];
await c.api.patch(`/v1/repositories/${repoA.id}/issues`, {
  enabled: false, githubRepo: 'example/hello-site', label: 'ready-for-agents', pollMinutes: 15, closeOnComplete: true, postComments: false,
});
ev.note(`setup (API): imported house-style v1 (${pv.shortHash}) from ${src}; pinned it to QA; issue settings for ${repoA.name} (label ready-for-agents, every 15 min)`);

// ---- export, in the window
const exported = await exportInWindow(c);
ev.check('the export lists .tandemise/skills.lock and .tandemise/issues.yaml', exported.text.includes('.tandemise/skills.lock') && exported.text.includes('.tandemise/issues.yaml'), exported.text.slice(0, 900));
await page.evaluate(`document.querySelector('[aria-label="Export result"]').scrollIntoView({ block: 'center' })`);
await c.sleep(300);
await page.screenshot(ev.shot('export-skills-lock'));
const lockText = readSetupFile(c, 'skills.lock');
const lock = YAML.parse(lockText);
ev.check('on disk: skills.lock names house-style v1 with its hash and folder', lock.skills?.length === 1 && lock.skills[0].name === 'house-style' && lock.skills[0].version === 1 && lock.skills[0].hash === pv.hash && lock.skills[0].source?.path === src, lock);
ev.check('on disk: skills.lock has none of the skill\'s content', !lockText.includes(BODY) && !lockText.includes('How we name'));
ev.check('on disk: roles/qa.md carries the pin with its hash', readSetupFile(c, 'roles/qa.md').includes(`skills:\n  - hash: ${pv.hash}\n    name: house-style\n    version: 1\n`), readSetupFile(c, 'roles/qa.md').slice(0, 700));

// ---- a home without those files: the pin is dropped and the skill deleted, so its store no longer has them.
await putQa(ws, qa, null);
await c.api.del(`/v1/skills/${imported.skill.id}`);
const storeDir = join(SCRATCH, 'home', 'skills', pv.hash);
ev.check('proof (disk): the skills store no longer has the files', !existsSync(storeDir), storeDir);

// ---- a second project, with a repository of the same name
const twoDir = join(SCRATCH, 'machine-two', 'project');
mkdirSync(twoDir, { recursive: true });
if (!existsSync(join(twoDir, '.git'))) {
  const git = (...a) => execFileSync('git', a, { cwd: twoDir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(twoDir, 'README.md'), '# second machine\n');
  git('-c', 'user.email=demo@example.com', '-c', 'user.name=Demo', 'add', '-A');
  git('-c', 'user.email=demo@example.com', '-c', 'user.name=Demo', 'commit', '-q', '-m', 'init');
}
const two = (await c.api.post('/v1/workspaces', { name: 'Second machine' })).workspace.id;
await c.api.post(`/v1/workspaces/${two}/repositories`, { path: twoDir, name: repoA.name });
writeState({ q5: { two, hash: pv.hash, repository: repoA.name } });
ev.note(`a second project "Second machine" with a repository named ${repoA.name}; the window switches to it`);
await showProject(c, two);

const preview = await previewInWindow(c, c.env.project);
const skillRow = await previewRow(c, 'house-style v1');
ev.check('the skill row: "house-style v1: Add" with "Needs import: house-style from <folder>"', skillRow?.[1].includes(`Needs import: house-style from ${src}`), skillRow);
ev.check('it cannot be taken: its choice reads "Keep mine"', skillRow?.[1].includes('Keep mine') && !(await page.evaluate(`Boolean(document.querySelector('[aria-label="Choice for house-style v1"]'))`)));
const qaRow = await previewRow(c, 'QA Engineer');
ev.check('the QA role that pins it cannot be taken yet, and says why', qaRow?.[1].includes('Needs import: house-style') && !(await page.evaluate(`Boolean(document.querySelector('[aria-label="Choice for QA Engineer"]'))`)), qaRow);
ev.check('the row offers "Fetch house-style from its source…"', skillRow?.[1].includes('Fetch house-style from its source…'), skillRow);
await page.evaluate(`[...document.querySelectorAll('[aria-label="Import preview"] tbody tr')].find((r) => r.getAttribute('aria-label').startsWith('house-style v1'))?.scrollIntoView({ block: 'center' })`);
await c.sleep(300);
await page.screenshot(ev.shot('needs-import'));
ev.note(`preview: ${preview.split('\n')[0]}`);

// ---- fetch it, with the Skills screen's preview
await clickInSetup(c, 'Fetch house-style from its source');
const fetchText = await c.until(async () => { const t = await page.evaluate(`document.querySelector('[aria-label="Import a pinned skill"]')?.innerText ?? ''`); return t.includes('Import house-style') && t; }, { label: 'skill preview', timeoutMs: 20_000 });
ev.check('the fetch shows the skill\'s preview: name, hash, SKILL.md, "New skill"', fetchText.includes('house-style') && fetchText.includes(pv.shortHash) && fetchText.includes('New skill') && fetchText.includes('Keep functions short'), fetchText.slice(0, 600));
await page.evaluate(`document.querySelector('[aria-label="Import a pinned skill"]').scrollIntoView({ block: 'center' })`);
await c.sleep(300);
await page.screenshot(ev.shot('fetch-preview'));
await clickInSetup(c, 'Import house-style');
await c.until(async () => (await previewRow(c, 'house-style v1'))?.[0] === 'house-style v1: Same', { label: 'skill row Same', timeoutMs: 30_000 });
ev.check('after importing, the folder is read again: "house-style v1: Same"', (await previewRow(c, 'house-style v1'))?.[0] === 'house-style v1: Same');
const qaAfter = await previewRow(c, 'QA Engineer');
ev.check('and the QA role can be taken: "QA Engineer: Change", Take theirs', qaAfter?.[0] === 'QA Engineer: Change' && !qaAfter[1].includes('Needs import') && await page.evaluate(`document.querySelector('[aria-label="Choice for QA Engineer"] [aria-pressed="true"]')?.innerText.trim() === 'Take theirs'`), qaAfter);
ev.check('proof (API): house-style v1 is in the second project\'s library with the same hash', (await c.api.get(`/v1/workspaces/${two}/skills`)).skills.some((s) => s.name === 'house-style' && s.versions.some((v) => v.hash === pv.hash)));

// This project keeps its own name and settings: only what the files add to it is taken.
await page.evaluate(`[...document.querySelectorAll('[aria-label="Choice for Project settings"] button')].find((b) => b.innerText.trim() === 'Keep mine')?.click()`);
await c.sleep(300);
const applied = await applyInWindow(c);
ev.check('applied, and the lines name the QA role', applied.includes('Changed QA Engineer: skills: none → house-style'), applied.slice(0, 600));
const qaTwo = (await c.api.get(`/v1/roles?workspaceId=${two}`)).find((r) => r.id === 'qa');
ev.check('proof (API): QA in the second project pins house-style v1', JSON.stringify(qaTwo?.skills) === JSON.stringify([{ name: 'house-style', version: 1 }]), qaTwo?.skills);
const again = await previewInWindow(c, c.env.project);
ev.check('reading the folder again: the skill and QA are Same', (await previewRow(c, 'house-style v1'))?.[0] === 'house-style v1: Same' && (await previewRow(c, 'QA Engineer'))?.[0] === 'QA Engineer: Same', again.split('\n')[0]);
await clickInSetup(c, 'Cancel');

c.close(); ev.save();
