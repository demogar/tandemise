// D5 — Park a finished step whose next step is ready. On "P3 hold" the design finishes and the build waits on
// its start approval, ready to run on that design. Continue elsewhere on the finished design holds the build:
// its start card is withdrawn and it waits with "Waiting for 'design' from Figma.". After the hand-back (a file)
// the build asks to start again, is approved in the Inbox, and runs on the handed-back version, not round 1.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import {
  DIALOG_FILE, card, clickInDialog, continueElsewhere, docsSize, ensureTeam, openFeed, openHandBack, startMission, waitTask, writeState,
} from '../common.mjs';

const c = await context();
const { page, api, until } = c;
await docsSize(c);
const ev = new Evidence('D5', 'A ready next step waits for the hand-back, then runs on the handed-back version');
await ensureTeam(c);

// SCRIPTED_WORKSPACE_LINK: the agents' handoffs also link README.md by path (D6 reads that).
const goal = 'Hello page, redesigned by hand SCRIPTED_WORKSPACE_LINK';
const missionId = await startMission(c, goal, 'P3 hold');
writeState({ d5: { missionId, goal } });
const done = await waitTask(c, missionId, 'design', (t) => t.status === 'SUCCEEDED', 'design finished', 60_000);
const ready = await waitTask(c, missionId, 'build', (t) => t.status === 'AWAITING_APPROVAL', 'build asks to start', 60_000);
const startCard = async () => (await c.approvals(missionId, 'PENDING')).find((a) => a.taskId === ready.id && a.kind === 'action');
const first = await startCard();
ev.check('the design finished (round 1) and the build is ready, asking to start', done.round === 1 && ready.status === 'AWAITING_APPROVAL' && first !== undefined, { design: done.status, build: ready.status, card: first?.title });
const round1 = (await api.get(`/v1/missions/${missionId}`)).artifacts.find((a) => a.type === 'DesignBrief' && a.taskId === done.id);

// The window offers "Continue elsewhere" on the finished design while nothing has run on it.
await openFeed(c, missionId);
const offered = await until(async () => (await card(c, 'design')).includes('Continue elsewhere'), { label: 'Continue elsewhere offered', timeoutMs: 15_000 }).catch(() => false);
const designCard = await card(c, 'design');
await page.evaluate(`document.querySelector('[data-feed-card="design"]')?.scrollIntoView({ block: 'center' })`);
await page.screenshot(ev.shot('finished-design-card'));
ev.check('the finished design\'s card offers "Continue elsewhere" while the build only asks to start', offered, {
  card: designCard, build: { status: ready.status, runCount: ready.runCount, statusReason: ready.statusReason },
});
let parked;
if (offered) {
  ({ parked } = await continueElsewhere(c, missionId, 'design', 'Figma', { shot: ev.shot('continue-finished-design') }));
} else {
  // Recorded as a finding above. The rest of the scenario is still observed, parked through the daemon's own
  // route (what the dialog would have sent), so D6 and D7 have their hand-back; this is not proof of the window.
  ev.note('WORKAROUND: the window offered no "Continue elsewhere", so the design was parked through POST /v1/tasks/:id/park { tool: "Figma" } for the rest of the scenario');
  await api.post(`/v1/tasks/${done.id}/park`, { tool: 'Figma' });
  parked = await waitTask(c, missionId, 'design', (t) => t.parkedExternal != null, 'design parked', 20_000);
}
ev.check('the finished design is parked in Figma', parked.status === 'AWAITING_EXTERNAL' && parked.parkedExternal?.tool === 'Figma', { status: parked.status, parkedExternal: parked.parkedExternal });
const held = await waitTask(c, missionId, 'build', (t) => t.status === 'PENDING', 'build held', 20_000).catch(() => c.task(missionId, 'build'));
const reason = "Waiting for 'design' from Figma.";
ev.check(`proof (API): the build went back to PENDING with "${reason}"`, held.status === 'PENDING' && held.statusReason === reason, { status: held.status, statusReason: held.statusReason });
ev.check('proof (API): its start card was withdrawn', (await startCard()) === undefined, (await c.approvals(missionId)).filter((a) => a.taskId === ready.id).map((a) => `${a.title}: ${a.status}`));

// Where the window says it: the feed, the Plan tab, and the build's drawer.
const say = async () => (await page.text('body')).includes(reason);
await openFeed(c, missionId);
let where = (await say()) ? 'feed' : null;
if (where) await page.screenshot(ev.shot('build-held-feed'));
await page.navigate(`#/missions/${missionId}/plan`);
await c.sleep(1200);
if (await say()) { where = where ? `${where}, plan` : 'plan'; await page.screenshot(ev.shot('build-held-plan')); }
await c.openTaskDrawer(missionId, 'build').catch(() => undefined);
const drawer = await c.dialogText('build');
if (drawer.includes(reason)) { where = where ? `${where}, drawer` : 'drawer'; await page.screenshot(ev.shot('build-held-drawer')); }
ev.check(`the window shows the build "${reason}"`, where !== null, where ?? drawer.slice(0, 400));
await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

// Hand back a file.
const v2 = '# Hello page, v2\n\nThe greeting is larger and sits higher. Colours: warm, #f6c28b on #fffaf3.\n';
await openHandBack(c, missionId, 'design', 'Reworked the greeting in Figma: larger, higher, warmer colours.');
await page.attachFile(DIALOG_FILE, { name: 'hello-design-v2.md', type: 'text/markdown', text: v2 });
ev.check('the hand-back holds the file', (await c.dialogText('Hand back ')).includes('hello-design-v2.md'));
await page.screenshot(ev.shot('hand-back-file'));
await clickInDialog(c, 'Hand back');
const back = await waitTask(c, missionId, 'design', (t) => t.parkedExternal === null && t.round === 2, 'handed back', 60_000);
const round2 = (await api.get(`/v1/missions/${missionId}`)).artifacts.find((a) => a.type === 'DesignBrief' && a.taskId === back.id && a.round === 2);
ev.check('proof (API): design round 2 is SUCCEEDED, and its DesignBrief supersedes round 1', back.status === 'SUCCEEDED' && round2 !== undefined && round2.supersedes === round1?.id, { status: back.status, round2: round2?.id, supersedes: round2?.supersedes, round1: round1?.id });

// The build is released, asks again, and is approved in the window.
const again = await until(startCard, { label: 'build asks to start again', timeoutMs: 60_000 }).catch(() => undefined);
ev.check('the build is released and asks to start again', again !== undefined, again?.title);
await openFeed(c, missionId);
await page.screenshot(ev.shot('released-after-hand-back'));
if (again) await c.decideInInbox(again.title, { filter: 'Everyone' });
const built = await waitTask(c, missionId, 'build', (t) => ['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(t.status), 'build finished', 90_000);
ev.check('the build ran and finished', built.status === 'SUCCEEDED', { status: built.status, statusReason: built.statusReason });
const runs = c.runs(built.id);
const inputs = runs.flatMap((r) => c.sql('SELECT artifact_id AS id FROM run_inputs WHERE run_id = ?', r.id).map((x) => x.id));
ev.check('the build ran once, and it read the handed-back DesignBrief (round 2), never round 1', runs.length === 1 && inputs.includes(round2?.id) && !inputs.includes(round1?.id), { runs: runs.length, inputs, round1: round1?.id, round2: round2?.id });
const prompt = c.prompts().filter((p) => p.includes(goal) && p.includes('### ChangeSet')).pop() ?? '';
ev.check('the build\'s prompt carries the handed-back work', prompt.includes('Reworked the greeting in Figma') && prompt.includes('#f6c28b'), prompt.slice(Math.max(0, prompt.indexOf('Reworked') - 100), prompt.indexOf('Reworked') + 300));
await openFeed(c, missionId);
const text = await card(c, 'build');
ev.check('the build card is finished in the window', /Done|Succeeded|ready/i.test(text), text.slice(0, 300));
await page.evaluate(`document.querySelector('[data-feed-card="build"]')?.scrollIntoView({ block: 'center' })`);
await page.screenshot(ev.shot('build-ran-on-hand-back'));

c.close(); ev.save();
