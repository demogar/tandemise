// P3 Task 6: the desktop surface for outside contributions, in the real app.
//
//   npm run build && node scratch/p3-ui-shots.mjs
//
// A fresh install behind /tmp/tdm-p3 (the P0 acceptance setup: daemon from this
// checkout, scripted agents), the real window over CDP on 9337, and a
// screenshot of each state into /tmp/tdm-p3/shots. It asserts the DOM as it
// goes and prints a summary; every process it starts is stopped at the end.
//
// Two states cannot be reached through the product today and are staged in
// SQLite, for the screenshot only: a stage covered by an upload (the scripted
// planner never emits `skipped`), and a dependent that already used a parked
// step (the daemon refuses to park once anything has). Both are said below.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SCR = '/tmp/tdm-p3';
const PORT = 9337;
const SHOTS = join(SCR, 'shots');
const FILES = join(SCR, 'files');

for (const p of [`user-data-dir=${SCR}/electron`]) { try { execFileSync('pkill', ['-f', p]); } catch { /* none */ } }
if (existsSync(`${SCR}/env.json`)) { try { process.kill(JSON.parse(readFileSync(`${SCR}/env.json`, 'utf8')).pid); } catch { /* gone */ } }
rmSync(SCR, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });
mkdirSync(FILES, { recursive: true });

// Inputs for the pickers: a small image (intake reads it as a DesignBrief), a spec, a hand-back, and one over 24 MB.
// A 1x1 PNG, so intake sees a real image media type.
writeFileSync(join(FILES, 'hello-design.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
writeFileSync(join(FILES, 'hello-spec.md'), '# Hello page\n\nA page that greets the visitor by name.\n');
writeFileSync(join(FILES, 'figma-export.md'), '# Hello page design\n\nLarge greeting, warm colour, centred.\n');
writeFileSync(join(FILES, 'too-big.bin'), Buffer.alloc(25 * 1024 * 1024));
writeFileSync(join(FILES, 'half-a.bin'), Buffer.alloc(13 * 1024 * 1024));
writeFileSync(join(FILES, 'half-b.bin'), Buffer.alloc(13 * 1024 * 1024));

execFileSync(process.execPath, [join(root, 'scratch/acceptance/p0/setup.mjs'), SCR], { env: { ...process.env, SCRIPTED_DELAY_MS: '800' }, stdio: ['ignore', 'ignore', 'inherit'] });
const env = JSON.parse(readFileSync(`${SCR}/env.json`, 'utf8'));

const desktop = spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${PORT}`, `--user-data-dir=${SCR}/electron`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
  cwd: join(root, 'apps/desktop'), env: { ...process.env, TANDEMISE_HOME: env.home }, stdio: 'ignore', detached: true,
});
const stopAll = () => {
  try { process.kill(-desktop.pid, 'SIGTERM'); } catch { /* gone */ }
  try { execFileSync('pkill', ['-f', `user-data-dir=${SCR}/electron`]); } catch { /* none */ }
  try { process.kill(env.pid, 'SIGTERM'); } catch { /* gone */ }
};
process.on('exit', stopAll);

// ctx.mjs reads its scratch dir and port when imported.
process.env.ACCEPTANCE_SCRATCH = SCR;
process.env.CDP_PORT = String(PORT);
const { context } = await import('./acceptance/p0/lib/ctx.mjs');
const { agent } = await import('./acceptance/p2/common.mjs');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail).slice(0, 500)}`}`); }
};

try {
  const c = await context();
  const { page, api, sleep, until } = c;
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  const shot = async (name) => { await sleep(500); await page.screenshot(join(SHOTS, `${name}.png`)); console.log(`  shot ${name}.png`); };
  const db = () => new DatabaseSync(join(env.home, 'tandemise.db'));
  const exec = (sql, ...params) => { const d = db(); try { d.prepare(sql).run(...params); } finally { d.close(); } };
  const body = () => page.text();
  const dialog = (prefix) => c.dialogText(prefix);
  const inDialog = (text) => page.evaluate(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].pop(); const b = d && [...d.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(text)} && !x.disabled); if (!b) return false; b.click(); return true; })()`);
  /** Puts a file into the nth hidden file input, as picking it in the native dialog would. */
  const pickFile = async (path, nth = 0) => {
    const { root: doc } = await page.send('DOM.getDocument', { depth: -1 });
    const { nodeIds } = await page.send('DOM.querySelectorAll', { nodeId: doc.nodeId, selector: 'input[type=file]' });
    await page.send('DOM.setFileInputFiles', { nodeId: nodeIds[nth], files: [path] });
    await sleep(700);
  };

  const designer = await agent(c, 'Design agent', ['design'], env.scriptedProfileId);
  const coder = await agent(c, 'Coding agent', ['development'], env.scriptedProfileId);
  const reviewer = await agent(c, 'Review agent', ['review'], env.scriptedProfileId);
  await c.staff({ design: { assignees: [designer], reviews: [] }, development: { assignees: [coder], reviews: [] }, review: { assignees: [reviewer], reviews: [] } });

  // ---------------------------------------------------------------- New mission with uploads
  console.log('\n== New mission: two uploads, and a file over 24 MB refused on the spot');
  await page.navigate('#/missions/new');
  await page.waitForText('What outcome do you want?');
  await page.fill('What outcome do you want?', 'A hello page that greets the visitor by name');
  await page.fill('Done when', 'The page greets the visitor by name');
  await page.select('Repository', 'acceptance-project');
  // P5's first stage writes a ProductSpec, which is what intake makes of the uploaded spec.
  await page.select('Workflow', 'P5 done when');
  await pickFile(join(FILES, 'too-big.bin'));
  check('a file over 24 MB is refused in the picker, in the daemon\'s words', (await body()).includes('That file is larger than 24 MB.'));
  await shot('01a-new-mission-too-big');
  // Each under the cap, together over it: the second is refused and the first stays.
  await pickFile(join(FILES, 'half-a.bin'));
  await pickFile(join(FILES, 'half-b.bin'));
  check('files adding up past 24 MB are refused, in the daemon\'s words', (await body()).includes('These files add up to more than 24 MB. Add the rest later as feedback.'));
  await page.evaluate(`document.querySelector('.contrib').scrollIntoView({ block: 'center' })`);
  await shot('01b-new-mission-total-too-big');
  await page.evaluate(`[...document.querySelectorAll('.contrib__remove')].forEach((b) => b.click())`);
  await sleep(300);
  await pickFile(join(FILES, 'hello-design.png'));
  await pickFile(join(FILES, 'hello-spec.md'));
  const chips = await page.evaluate(`[...document.querySelectorAll('.contrib__chip')].map((x) => x.innerText.trim())`);
  check('two uploads show as chips', chips.length === 2 && chips[0].includes('hello-design.png') && chips[1].includes('hello-spec.md'), chips);
  check('the refusal clears once a file is taken', !(await body()).includes('That file is larger than 24 MB.'));
  await page.evaluate(`document.querySelector('.contrib').scrollIntoView({ block: 'center' })`);
  await shot('01-new-mission-two-uploads');
  await page.click('Plan mission …');
  const coveredId = await until(async () => { const h = await page.evaluate('location.hash'); return /#\/missions\/msn_/.test(h) && h.split('/')[2]; }, { label: 'mission page', timeoutMs: 30_000 });
  const uploaded = await until(async () => { const d = await api.get(`/v1/missions/${coveredId}`); return (d.uploads ?? []).length === 2 && d.tasks.length > 0 && d; }, { label: 'uploads pinned and planned', timeoutMs: 60_000 });
  check('the mission carries both uploads', uploaded.uploads.map((u) => u.filename).sort().join(',') === 'hello-design.png,hello-spec.md', uploaded.uploads);
  const intake = await until(async () => { const d = await api.get(`/v1/missions/${coveredId}`); return d.uploads.find((u) => u.intakeArtifactId !== null) && d; }, { label: 'intake', timeoutMs: 60_000 }).catch(() => null);
  const design = uploaded.tasks.find((t) => t.key === 'design');
  // Staged: the scripted planner does not emit `skipped`, so the placeholder the planner would write is written here.
  const covered = intake?.uploads.find((u) => u.intakeArtifactId !== null);
  if (covered) {
    const art = await api.get(`/v1/artifacts/${covered.intakeArtifactId}`);
    const holder = uploaded.tasks.find((t) => t.expectedOutputs.includes(art.manifest.type)) ?? design;
    exec(`UPDATE mission_tasks SET status = 'SKIPPED', status_reason = ? WHERE id = ?`, `Covered by your upload: ${covered.filename}`, holder.id);
    await page.navigate(`#/missions/${coveredId}/plan`);
    await page.send('Page.reload', {});
    await page.waitForText('covered by your upload', { timeoutMs: 20_000 }).catch(() => '');
    const row = await page.evaluate(`document.querySelector('.taskcard--covered')?.innerText ?? ''`);
    check('the plan shows "<stage> · covered by your upload" with the filename', row.includes('covered by your upload') && row.includes(covered.filename), row);
    check('the covered row has no status dot', await page.evaluate(`!document.querySelector('.taskcard--covered .dot')`));
    await shot('05-covered-by-upload-row');
    await page.evaluate(`document.querySelector('.taskcard--covered')?.click()`);
    await sleep(800);
    const drawer = await page.evaluate(`[...document.querySelectorAll('[role=dialog]')].pop()?.innerText ?? ''`);
    check('the covered step offers neither Retry nor Request changes', !/Retry task|Request changes/.test(drawer), drawer.slice(0, 300));
    await shot('05b-covered-step-drawer');
    await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  } else {
    check('intake produced an artifact for an upload', false, intake?.uploads ?? 'no intake');
  }
  await api.post(`/v1/missions/${coveredId}/cancel`, { reason: 'shots: covered row seen' }).catch(() => undefined);

  // ---------------------------------------------------------------- A draft's uploads, read-only on Get it ready
  console.log('\n== Get it ready lists a draft\'s uploads');
  const b64 = (f) => readFileSync(join(FILES, f)).toString('base64');
  const draft = await api.post('/v1/missions', {
    workspaceId: env.workspaceId, repositoryId: null, goal: 'A welcome email for new visitors', constraints: [], successCriteria: [],
    autonomy: 'balanced', workflowPreset: 'feature-delivery', workflowInputs: {}, baseBranch: null, planNow: false,
    uploads: [
      { kind: 'file', filename: 'hello-spec.md', mediaType: 'text/markdown', dataBase64: b64('hello-spec.md') },
      { kind: 'link', url: 'https://www.figma.com/file/abc123/welcome', export: { filename: 'welcome-export.png', mediaType: 'image/png', dataBase64: b64('hello-design.png') } },
    ],
  });
  await page.navigate(`#/missions/${draft.mission.id}`);
  await page.waitForText('Your uploads', { timeoutMs: 20_000 }).catch(() => '');
  const uploadsText = await page.evaluate(`document.querySelector('section[aria-label="Your uploads"]')?.innerText ?? ''`);
  check('Get it ready lists both uploads', uploadsText.includes('hello-spec.md') && uploadsText.includes('welcome-export.png'), uploadsText);
  await page.evaluate(`document.querySelector('section[aria-label="Your uploads"]')?.scrollIntoView({ block: 'center' })`);
  await shot('08-get-ready-uploads');
  await api.post(`/v1/missions/${draft.mission.id}/cancel`, { reason: 'shots: uploads seen' }).catch(() => undefined);

  // ---------------------------------------------------------------- Continue elsewhere, parked card
  console.log('\n== Continue elsewhere and a parked card');
  const title = 'Hello page SCRIPTED_SLOW_20S';
  const missionId = await c.createMission(title, { workflow: 'P2 chain' });
  await c.approvePlan(missionId, title);
  await until(async () => (await c.task(missionId, 'design'))?.status === 'RUNNING', { label: 'design running', timeoutMs: 30_000 });
  await page.navigate(`#/missions/${missionId}`);
  await page.waitForText('Continue elsewhere', { timeoutMs: 20_000 });
  await shot('02a-card-continue-elsewhere');
  await page.clickIn('design', 'Continue elsewhere', { rowSelector: 'article.feedcard' });
  const cont = await until(() => dialog('Continue design elsewhere'), { label: 'continue dialog', timeoutMs: 5_000 });
  check('Continue elsewhere prefills Figma for a design', await page.evaluate(`[...document.querySelectorAll('[role=dialog] input')].pop()?.value === 'Figma'`), cont);
  await shot('02b-continue-elsewhere-dialog');
  check('clicked Continue elsewhere', await inDialog('Continue elsewhere'));
  const parked = await until(async () => { const t = await c.task(missionId, 'design'); return t.parkedExternal && t; }, { label: 'parked', timeoutMs: 15_000 });
  check('the step is parked in Figma', parked.status === 'AWAITING_EXTERNAL' && parked.parkedExternal.tool === 'Figma', parked.parkedExternal);
  await page.waitForText('Waiting for your work in Figma', { timeoutMs: 15_000 });
  check('the card says "Waiting for your work in Figma" and offers Hand back', /Waiting for your work in Figma\s*Hand back/.test(await body()));
  await shot('02-parked-card');

  console.log('\n== Inbox');
  await page.navigate('#/inbox');
  await page.waitForText('Waiting for your work in Figma', { timeoutMs: 15_000 });
  const inboxRow = await page.evaluate(`[...document.querySelectorAll('.inbox__row')].find((r) => r.innerText.includes('Waiting for your work in Figma'))?.innerText ?? ''`);
  check('the Inbox lists the parked step', inboxRow.includes('design') && inboxRow.includes('Hand back'), inboxRow);
  await shot('06-inbox-parked-row');
  await page.navigate('#/');
  await page.waitForText('Waiting for your work in Figma', { timeoutMs: 15_000 }).catch(() => '');
  await shot('06b-home-parked-row');

  console.log('\n== Hand back: the redo/keep choice (staged dependent)');
  const build = await c.task(missionId, 'build');
  const designRun = c.sql('SELECT * FROM runs WHERE task_id = ? ORDER BY attempt DESC LIMIT 1', parked.id)[0];
  // Staged: the daemon refuses to park a step whose output anything used, so a build that used it is written here.
  exec(`INSERT INTO runs (id, mission_id, task_id, assignment_id, attempt, status, role_id, runtime_profile_id, execution_target_id, started_at, finished_at)
        VALUES ('run_shotstaged000000000', ?, ?, ?, 1, 'SUCCEEDED', ?, ?, ?, ?, ?)`,
    missionId, build.id, designRun.assignment_id, designRun.role_id, designRun.runtime_profile_id, designRun.execution_target_id, designRun.started_at, designRun.started_at);
  exec(`UPDATE mission_tasks SET status = 'SUCCEEDED' WHERE id = ?`, build.id);
  await page.navigate(`#/missions/${missionId}`);
  await page.send('Page.reload', {});
  await page.waitForText('Waiting for your work in Figma', { timeoutMs: 20_000 });
  await page.clickIn('Waiting for your work in Figma', 'Hand back', { rowSelector: 'article.feedcard' });
  const choice = await until(() => dialog('Hand back design'), { label: 'hand-back dialog', timeoutMs: 5_000 });
  check('the hand-back asks Redo or Keep when a dependent used the step', /Build \(done\) used the earlier version/.test(choice) && /Redo them after the new version/.test(choice) && /Keep their work/.test(choice), choice);
  await page.fill('What did you do in Figma?', 'Moved the greeting up and made it larger.');
  await shot('03-hand-back-redo-keep');
  await page.evaluate(`document.documentElement.setAttribute('data-theme', 'light')`);
  await shot('03d-hand-back-light');
  await page.evaluate(`document.documentElement.removeAttribute('data-theme')`);
  await page.click('Cancel', { within: '[role=dialog]' });
  exec(`DELETE FROM runs WHERE id = 'run_shotstaged000000000'`);
  exec(`UPDATE mission_tasks SET status = ? WHERE id = ?`, build.status, build.id);

  console.log('\n== Hand back: a bare link is refused in the daemon\'s words');
  await page.send('Page.reload', {});
  await page.waitForText('Waiting for your work in Figma', { timeoutMs: 20_000 });
  await page.clickIn('Waiting for your work in Figma', 'Hand back', { rowSelector: 'article.feedcard' });
  await until(() => dialog('Hand back design'), { label: 'hand-back dialog', timeoutMs: 5_000 });
  check('no redo/keep without a dependent that used it', !/Keep their work/.test(await dialog('Hand back design')));
  await page.fill('What did you do in Figma?', 'Moved the greeting up and made it larger.');
  await page.click('Add link', { within: '[role=dialog]' });
  await page.fill('Link', 'https://www.figma.com/file/abc123/hello');
  await page.click('Add', { within: '[role=dialog]' });
  await inDialog('Hand back');
  const refused = await until(async () => { const t = await dialog('Hand back design'); return t.includes('Attach an export') && t.includes('Nothing here can read that link') && t; }, { label: 'refusal', timeoutMs: 20_000 }).catch(() => dialog('Hand back design'));
  check('the refused bare link shows "Nothing here can read that link. Attach an export of it."', refused.includes('Nothing here can read that link. Attach an export of it.'), refused);
  await shot('03b-hand-back-bare-link-refused');

  console.log('\n== Hand back with a file, then the workspace link');
  await page.evaluate(`[...document.querySelectorAll('[role=dialog] .contrib__remove')].forEach((b) => b.click())`);
  await sleep(300);
  // The dialog's own picker input is the last file input on the page.
  const inputs = await page.evaluate(`document.querySelectorAll('input[type=file]').length`);
  await pickFile(join(FILES, 'figma-export.md'), inputs - 2);
  check('the export is the one contribution', (await dialog('Hand back design')).includes('figma-export.md'));
  await shot('03c-hand-back-with-file');
  await inDialog('Hand back');
  const back = await until(async () => { const t = await c.task(missionId, 'design'); return t.parkedExternal === null && t.round === 2 && t; }, { label: 'handed back', timeoutMs: 30_000 });
  check('the hand-back lands as round 2', back.round === 2 && back.status === 'SUCCEEDED', { status: back.status, round: back.round });
  await page.waitForText('Open workspace ↗', { timeoutMs: 20_000 });
  const card = await page.evaluate(`[...document.querySelectorAll('article.feedcard')].find((a) => a.innerText.includes('Open workspace ↗'))?.innerText ?? ''`);
  check('the handed-back card offers "Open workspace ↗"', card.includes('Open workspace ↗'), card);
  await until(async () => (await c.task(missionId, 'build')).runCount > 0, { label: 'build ran on the hand-back', timeoutMs: 30_000 });
  const designCard = () => page.evaluate(`[...document.querySelectorAll('article.feedcard')].find((a) => a.innerText.includes('Open workspace ↗'))?.innerText ?? ''`);
  const again = await until(async () => { const t = await designCard(); return !t.includes('Continue elsewhere') && t; }, { label: 'Continue elsewhere gone', timeoutMs: 15_000 }).catch(designCard);
  const buildNow = await c.task(missionId, 'build');
  check('once build ran on it, design no longer offers Continue elsewhere', !again.includes('Continue elsewhere'), { again, build: { runCount: buildNow.runCount, dependsOn: buildNow.dependsOn, status: buildNow.status } });
  const link = (await api.get(`/v1/missions/${missionId}`)).artifacts.find((a) => a.taskId === back.id && a.handoff?.links?.some((l) => l.kind === 'workspace'))?.handoff.links.find((l) => l.kind === 'workspace');
  const resolved = link ? await api.post('/v1/workspace-links/resolve', { workspaceId: env.workspaceId, path: link.path }).catch((e) => ({ error: e.message })) : null;
  check('the workspace link resolves to a file that exists', resolved?.path !== undefined && existsSync(resolved.path), resolved);
  await page.evaluate(`[...document.querySelectorAll('article.feedcard')].find((a) => a.innerText.includes('Open workspace ↗'))?.scrollIntoView({ block: 'center' })`);
  await shot('04-workspace-link-card');
  await page.clickIn('Open workspace ↗', 'Full doc', { rowSelector: 'article.feedcard' });
  await page.waitForText('Open workspace ↗', { selector: '[role=dialog]', timeoutMs: 10_000 }).catch(() => '');
  check('the reader offers "Open workspace ↗" too', (await page.evaluate(`[...document.querySelectorAll('[role=dialog]')].pop()?.innerText ?? ''`)).includes('Open workspace ↗'));
  await shot('04b-workspace-link-reader');
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(400);

  console.log('\n== Request changes with an attachment');
  await page.clickIn('Open workspace ↗', 'Request changes', { rowSelector: 'article.feedcard' });
  await until(() => dialog('Request changes to'), { label: 'composer', timeoutMs: 5_000 });
  await page.fill('What should change?', 'Use the colours in this export.');
  const count = await page.evaluate(`document.querySelectorAll('input[type=file]').length`);
  await pickFile(join(FILES, 'hello-design.png'), count - 2);
  check('the composer shows the attachment', (await dialog('Request changes to')).includes('hello-design.png'));
  await shot('07-request-changes-attachment');
  await page.click('Cancel', { within: '[role=dialog]' });
} catch (error) {
  failures.push(`threw: ${error.message}`);
  console.log(`  FAIL threw  ${error.stack}`);
}

stopAll();
console.log('\n' + '─'.repeat(60));
console.log(failures.length === 0 ? `ALL ${passed} P3 UI CHECKS PASSED; shots in ${SHOTS}` : `${passed} passed, ${failures.length} FAILED:\n  - ${failures.join('\n  - ')}`);
process.exit(failures.length === 0 ? 0 : 1);
