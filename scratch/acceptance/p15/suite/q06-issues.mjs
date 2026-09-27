// Q6 — GitHub issue settings travel with the setup and arrive off: after Q5's import into the second project, its
// Issues card for the repository of the same name holds the exported label and interval, its switch is off, and
// its status reads "Imported — review and turn on". Nothing was checked on GitHub.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { readState, readSetupFile, showProject, docsSize } from '../common.mjs';
import YAML from 'yaml';

const c = await context();
const { page } = c;
await docsSize(c);
const ev = new Evidence('Q6', 'Imported GitHub issue settings arrive off, marked "Imported — review and turn on"');
const { q5 } = readState();
if (!q5?.two) throw new Error('Q6 needs Q5 first (the second project)');

const exported = YAML.parse(readSetupFile(c, 'issues.yaml'));
const row = exported.repositories?.find((r) => r.repository === q5.repository);
ev.check('on disk: issues.yaml has the repository\'s settings, and no cursor or timestamp', row?.label === 'ready-for-agents' && row?.pollMinutes === 15 && row?.githubRepo === 'example/hello-site' && !readSetupFile(c, 'issues.yaml').includes('lastChecked'), exported);

await showProject(c, q5.two);
await page.navigate('#/project');
const card = await c.until(async () => { const t = await page.evaluate(`document.querySelector('section[aria-label="Issues"]')?.innerText ?? ''`); return t.includes('Imported') && t; }, { label: 'Issues card', timeoutMs: 20_000 });
await page.evaluate(`document.querySelector('section[aria-label="Issues"]').scrollIntoView({ block: 'start' })`);
await c.sleep(400);
const status = await page.evaluate(`document.querySelector('section[aria-label="Issues"] [aria-label="Issue status"]')?.innerText.trim() ?? ''`);
ev.check('the status reads "Imported — review and turn on"', status === 'Imported — review and turn on', status);
ev.check('the "Turn labelled issues into missions" switch is off', await page.evaluate(`document.querySelector('section[aria-label="Issues"] [role=switch][aria-label="Turn labelled issues into missions"]')?.getAttribute('aria-checked') === 'false'`));
ev.check('the label and the GitHub repository came across', await page.evaluate(`(() => { const s = document.querySelector('section[aria-label="Issues"]'); return s.querySelector('[aria-label="Label"]')?.value === 'ready-for-agents' && s.querySelector('[aria-label="GitHub repository"]')?.value === 'example/hello-site'; })()`), card.slice(0, 400));
await page.screenshot(ev.shot('issues-imported-off'));
const overview = await c.api.get(`/v1/workspaces/${q5.two}/issues`);
const s = overview.repositories.find((r) => r.repositoryName === q5.repository)?.settings;
ev.check('proof (API): off, every 15 minutes, close on complete, no comments, never checked', s?.enabled === false && s.pollMinutes === 15 && s.closeOnComplete === true && s.postComments === false && s.lastCheckedAt === null, s);

await showProject(c, c.env.workspaceId);
ev.note('the window is back on the acceptance project');
c.close(); ev.save();
