// N1 — The owner's normal day, across the five pivot sub-projects on one installation:
//   the project is linked to a brain on this machine (#70) → a signal pushed through intake lands in the fake
//   YouTrack and on the Board (#73) → Start on the Board → the planner picks the quick lane and says why (#71) →
//   while the step runs, Hold → type in the terminal → Continue (#72) → the ship step opens a pull request on the
//   fake gh and asks for review, auto-merge being off by default (#71) → the tracker item follows: In Progress,
//   then In Review, its activity comment linking the pull request (#73) → Home's "Who's working on what" shows
//   the claim as yours (#69).
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { calls, pullRequests } from '../../../fake-gh.mjs';
import { boardGroups, boardRow, cli, intakeStatus, openBoard, yt } from '../../intake/common.mjs';
import { holdFromCard, holdsOf, panelButton, panelLabel, panelText, typeLine, worktreeOf } from '../../hold/common.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('N1', "The owner's normal day: intake → Board → quick lane → hold → pull request → tracker → claims");
const ws = c.env.workspaceId;
const GH = `${c.env.scratch}/gh`;
const REPO = 'acme/web';
const TITLE = 'Typo in the settings title';
const CONTINUATION = 'A person held this task';
// A full-window screenshot (p0's, which times out rather than hang on a window that stopped painting).
const shot = (name) => page.screenshot(ev.shot(name)).catch((e) => ev.note(`screenshot ${name}: ${e.message}`));
// xterm draws its rows in an animation frame: ask for one (bounded), then read them.
const paint = () => Promise.race([page.send('Page.captureScreenshot', { format: 'jpeg', quality: 1 }), sleep(5000)]);
const screenText = async () => { await paint(); return page.evaluate(`[...document.querySelectorAll('.terminal-panel .xterm-rows > div')].map((r) => r.textContent.replace(/\\u00a0/g, ' ').trimEnd()).join('\\n')`); };
const waitScreen = (needle) => until(async () => { const t = await screenText(); return t.includes(needle) && t; }, { label: `terminal shows "${needle}"`, timeoutMs: 30_000, everyMs: 500 });

const CHANGESET = [
  '---', 'type: ChangeSet', 'schemaVersion: 1', 'title: Settings title typo fixed',
  'handoff:', '  headline: Settings title typo fixed', '  points:', '    - Fixed the spelling in the settings title',
  'branch: fix/settings-title', 'commits: []', 'filesChanged: 1', 'testsRun: []', 'knownLimitations: []', '---', '',
  '# Settings title', '', 'Fixed the typo in {{runId}}.', '',
].join('\n');
// The Coding agent's fake: it fixes the title and writes its ChangeSet, then works on (ten minutes), so there is
// time to hold it; the pass that continues a hold finishes at once.
const SCRIPT = {
  resume: 'ok',
  steps: [
    { kind: 'checkpoint', sessionId: 'sess-day-{{runId}}', label: 'session.init' },
    { kind: 'message', text: 'Fixing the settings title' },
    { kind: 'write-file', path: 'settings-title.txt', content: 'Settings\n' },
    { kind: 'write-file', path: '.tandemise/out/ChangeSet.md', content: CHANGESET },
    { kind: 'complete', summary: 'continued', when: { promptIncludes: CONTINUATION } },
    { kind: 'delay', ms: 600_000 },
    { kind: 'complete', summary: 'done' },
  ],
};

try {
  // ------------------------------------------------------------ the team: you and a Coding agent on the fake runtime
  const created = await api.post('/v1/runtimes', { adapterId: 'fake', name: 'Day fake', workspaceId: null, maxConcurrent: 2, enabled: true, settings: { script: SCRIPT } });
  const fakeId = (created.profile ?? created).id;
  await api.post(`/v1/workspaces/${ws}/members`, { kind: 'agent', name: 'Coding agent', reportsTo: c.me, roleIds: ['development'], runtimeProfileIds: [fakeId] });
  ev.note('setup: the Coding agent (development) runs on a fake runtime that resumes and opens an interactive session on a PTY');

  // ------------------------------------------------------------ the brain (#70)
  const linked = await api.post(`/v1/workspaces/${ws}/brain`, { mode: 'local' });
  ev.check('brain: the project is linked to a brain on this machine', linked.linked === true && linked.status === 'local_only', { linked: linked.linked, status: linked.status });
  const config = await api.get(`/v1/workspaces/${ws}/intake/config`);
  ev.check('brain: the project\'s intake still reads its tracker and web-form source', config.tracker?.kind === 'youtrack' && config.sources.some((s) => s.id === 'web-form'), { origin: config.origin, sources: config.sources.map((s) => s.id) });

  // ------------------------------------------------------------ intake (#73): a token, a push, filed in YouTrack
  await page.navigate('#/settings');
  await until(() => page.evaluate(`Boolean(document.querySelector('[data-custom-source="web-form"]'))`), { label: 'the custom source', timeoutMs: 30_000 });
  await page.evaluate(`document.querySelector('[data-custom-source="web-form"]').scrollIntoView({ block: 'center' })`);
  await page.click('Make a token', { within: '[data-custom-source="web-form"]' });
  const token = await until(() => page.evaluate(`document.querySelector('[data-custom-source="web-form"] [data-intake-token]')?.innerText.trim() ?? ''`), { label: 'the token', timeoutMs: 15_000 });
  ev.check('Settings → Intake: Make a token shows a tdi_ token', token.startsWith('tdi_'), `${token.slice(0, 8)}…`);
  const shell = { TANDEMISE_URL: c.env.url, TANDEMISE_INTAKE_TOKEN: token, TANDEMISE_HOME: `${c.env.scratch}/no-home` };
  const pushed = await cli(['intake', 'push', '--source', 'web-form', '--title', TITLE, '--url', 'https://forms.example.com/replies/7', '--key', 'form-7', '--description', 'The settings page says "Settigns".'], shell);
  ev.check('a shell pushes the signal (tandemise intake push exits 0)', pushed.code === 0, pushed);

  await openBoard(c, 'intake');
  const filed = await intakeStatus(c, 'custom:web-form:form-7', (s) => s.startsWith('Filed as'), 'Filed as …');
  const key = filed.status.slice('Filed as '.length);
  ev.check('Intake tab: the signal is filed in the tracker', /^GAR-\d+$/.test(key), filed);
  const item = await yt.issue(key);
  ev.check(`fake YouTrack: ${key} exists, a Bug, Open`, item?.summary === TITLE && item.type === 'Bug' && item.state === 'Open', item && { summary: item.summary, type: item.type, state: item.state });
  await shot('intake-filed');

  await openBoard(c);
  const row = await until(async () => { await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Check sources now')?.click()`); await sleep(1500); return boardRow(c, key); }, { label: `${key} on the Board`, timeoutMs: 60_000 });
  const groups = await boardGroups(c);
  ev.check(`Board: ${key} is under Ready with Start`, groups.ready?.rows.some((r) => r.key === key) && row.text.includes('Start'), row.text);
  await shot('board-ready');

  // ------------------------------------------------------------ Start → the planner's quick lane (#71)
  await page.evaluate(`document.querySelector('[data-board-item=${JSON.stringify(key)}] .board__start').click()`);
  const id = await until(async () => { const h = await page.evaluate('location.hash'); return /#\/missions\/msn_/.test(h) && h.split('/')[2]; }, { label: 'the mission opens', timeoutMs: 30_000 });
  ev.note(`mission ${id}`);
  const started = (await api.get(`/v1/missions/${id}`)).mission;
  ev.check('Start: the factory decides the workflow (auto)', started.workflowPreset === 'auto', started.workflowPreset);
  const running = await until(async () => { const s = (await api.get(`/v1/missions/${id}`)).mission.status; return ['EXECUTING', 'COMPLETE'].includes(s) && s; }, { label: 'executing', timeoutMs: 60_000 }).catch(async () => (await api.get(`/v1/missions/${id}`)).mission.status);
  ev.check('Start with no Done-when line plans at once (no draft, no refinement)', running === 'EXECUTING', running);
  ev.check('…and asks for no plan approval', !(await c.approvals(id)).some((a) => a.kind === 'plan'), (await c.approvals(id)).map((a) => a.title));

  await page.navigate(`#/missions/${id}/plan`);
  const why = await until(async () => { const t = await page.evaluate(`document.querySelector('section[aria-label="Why these steps"]')?.innerText ?? ''`); return t.includes('Quick lane') && t; }, { label: 'Why these steps', timeoutMs: 30_000 }).catch(() => '');
  ev.check('Plan → Why these steps: "Quick lane: one step, then a pull request."', why.includes('Quick lane: one step, then a pull request.'), why);
  ev.check('…profiled from the tracker as a fix', /Fix · /.test(why), why.split('\n').slice(0, 3));
  await shot('why-these-steps');

  // ------------------------------------------------------------ the tracker follows: In Progress (#73)
  const inProgress = await until(async () => (await yt.issue(key))?.state === 'In Progress', { label: 'In Progress', timeoutMs: 30_000 }).catch(() => false);
  ev.check(`fake YouTrack: ${key} is In Progress`, inProgress === true, (await yt.issue(key))?.state);

  // ------------------------------------------------------------ Hold → type → Continue (#72)
  const step = await until(async () => { const t = (await api.get(`/v1/missions/${id}`)).tasks.find((x) => x.key === 'implement'); return t?.status === 'RUNNING' && t.latestRun?.status === 'RUNNING' && t; }, { label: 'the implement step running', timeoutMs: 60_000 });
  ev.check('the implement step runs on the Coding agent\'s fake runtime', step.latestRun.runtimeProfileId === fakeId, step.runtimeName ?? step.latestRun.runtimeProfileId);
  await holdFromCard(c, id, 'implement');
  const header = await panelText(c);
  ev.check('Hold opens the terminal panel, "Held by You"', (await panelLabel(c)).startsWith('Terminal: ') && header.includes('Held by You'), header.slice(0, 200));
  await waitScreen('Fake session');
  await typeLine(c, 'write notes.txt');
  const screen = await waitScreen('wrote notes.txt').catch(() => screenText());
  ev.check('what you type reaches the session (it writes notes.txt)', screen.includes('wrote notes.txt'), screen.slice(-200));
  const worktree = await worktreeOf(c, id, step.id);
  ev.check('proof (disk): notes.txt is in the step\'s worktree', worktree !== null && existsSync(join(worktree, 'notes.txt')), worktree);
  await shot('held-terminal');
  await panelButton(c, 'Continue');
  await until(async () => (await panelLabel(c)) === '', { label: 'panel closes', timeoutMs: 20_000 });
  const done = await until(async () => { const t = (await api.get(`/v1/missions/${id}`)).tasks.find((x) => x.key === 'implement'); return ['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(t.status) && t; }, { label: 'implement settles', timeoutMs: 120_000 });
  ev.check('Continue: the step finishes on a resumed pass, no attempt spent', done.status === 'SUCCEEDED' && done.attempts === step.attempts, { status: done.status, reason: done.statusReason, attempts: [step.attempts, done.attempts] });
  const hold = holdsOf(c, step.id)[0];
  ev.check('proof (DB): the hold ended as continued', hold?.ending === 'continued', hold && { ending: hold.ending, diffStat: hold.diffStat });

  // ------------------------------------------------------------ ship: a pull request that asks for review (#71)
  const shipView = await until(async () => { const v = await api.get(`/v1/missions/${id}/ship`); return v.stage === 'review' && v.prs[0]?.decision && v; }, { label: 'the ship step asks', timeoutMs: 180_000 });
  const pr = shipView.prs[0];
  ev.check(`ship: one pull request opened on ${REPO}`, shipView.prs.length === 1 && pr.repo === REPO, { repo: pr.repo, number: pr.number, url: pr.url });
  ev.check('ship: waiting for your review, "Auto-merge is off for this project."', shipView.headline === 'Waiting for your review' && pr.decision.verdict === 'ask' && pr.decision.reasons.includes('Auto-merge is off for this project.'), { headline: shipView.headline, decision: pr.decision });
  const created2 = calls(GH).filter((x) => x.args[0] === 'pr' && x.args[1] === 'create');
  ev.check('fake gh: one `pr create`, and no `pr merge`', created2.length === 1 && !calls(GH).some((x) => x.args[0] === 'pr' && x.args[1] === 'merge'), created2.map((x) => x.args.join(' ')));
  const ghPr = pullRequests(GH, REPO).find((p) => p.number === pr.number);
  // The pushed branch, in the bare repository that stands in for GitHub: the agent's change and the one made in the hold.
  const branchFiles = ghPr === undefined ? '' : execFileSync('git', ['ls-tree', '-r', '--name-only', ghPr.headRefName], { cwd: `${c.env.scratch}/origin.git`, encoding: 'utf8' });
  ev.check("the pull request's branch carries the agent's change and the file made in the hold", branchFiles.includes("settings-title.txt") && branchFiles.includes("notes.txt"), { title: ghPr?.title, head: ghPr?.headRefName, files: branchFiles.split('\n').filter(Boolean) });
  const approvals = await c.approvals(id, 'PENDING');
  ev.check('Inbox: "Review and merge"', approvals.some((a) => a.title.startsWith('Review and merge')), approvals.map((a) => a.title));
  await c.openTaskDrawer(id, 'Ship');
  const card = await until(async () => { const t = await page.evaluate(`document.querySelector('[role=dialog] section[aria-label="Pull request"]')?.innerText ?? ''`); return t.includes('Waiting for your review') && t; }, { label: 'ship card', timeoutMs: 30_000 }).catch(() => '');
  ev.check('the ship card says "Waiting for your review" with Open in GitHub', card.includes('Open in GitHub'), card);
  await shot('ship-card');
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

  // ------------------------------------------------------------ the tracker follows: In Review, the PR linked (#73)
  const inReview = await until(async () => (await yt.issue(key))?.state === 'In Review', { label: 'In Review', timeoutMs: 45_000 }).catch(() => false);
  ev.check(`fake YouTrack: ${key} moved to In Review while the pull request waits for you`, inReview === true, (await yt.issue(key))?.state);
  // The activity comment is edited at most once a minute.
  const activity = await until(async () => { const list = (await yt.comments(key)).filter((x) => x.text.startsWith('<!-- tandemise:activity -->')); return list.some((x) => x.text.includes(pr.url)) && list; }, { label: 'activity links the PR', timeoutMs: 100_000 }).catch(async () => (await yt.comments(key)).map((x) => x.text));
  ev.check('fake YouTrack: one activity comment, linking the pull request', Array.isArray(activity) && activity.length === 1 && activity[0].text?.includes(pr.url), activity);
  await openBoard(c);
  const reviewRow = await boardRow(c, key);
  ev.check(`Board: ${key} shows its mission`, reviewRow !== undefined && /Mission:/.test(reviewRow.text), reviewRow?.text);
  await shot('board-after');

  // ------------------------------------------------------------ Who's working on what (#69)
  await page.navigate('#/');
  const who = await until(async () => { const t = await page.evaluate(`document.querySelector('section[aria-label="Who\\'s working on what"]')?.innerText ?? ''`); return t.includes(key) && t; }, { label: 'the claim row', timeoutMs: 20_000 }).catch(async () => page.evaluate(`document.querySelector('section[aria-label="Who\\'s working on what"]')?.innerText ?? ''`));
  ev.check(`Home → Who's working on what: ${key} (${TITLE}), yours`, who.includes(key) && who.includes(TITLE) && who.includes('You'), who);
  await shot('home-who');
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
  await page.screenshot(ev.shot('failure')).catch(() => {});
}
c.close(); ev.save();
