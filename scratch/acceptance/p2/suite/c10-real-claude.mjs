// C10 — Real Claude: a doc round on Claude Code continues the same session, and the tweak shows in the reader's
// version switcher and line comparison.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { assertSolo, noRecordingFor, agent, resetStaffing, cancel } from '../common.mjs';

const c = await context();
const { page, api, sleep, until } = c;
const ev = new Evidence('C10', 'Real Claude: round 2 continues the session; the reader shows the tweak between versions');
await assertSolo(c, ev);
let claude = (await api.get('/v1/runtimes')).map((r) => r.profile ?? r).find((p) => p.adapterId === 'claude-code');
if (!claude) {
  claude = await api.post('/v1/runtimes', { adapterId: 'claude-code', name: 'Claude Code', workspaceId: null, executablePath: `${process.env.HOME}/.local/bin/claude`, settings: { configDir: '~/.claude-home' }, maxConcurrent: 1, enabled: true });
  claude = claude.profile ?? claude;
} else if (!claude.enabled) {
  await api.patch(`/v1/runtimes/${claude.id}`, { enabled: true });
}
const writer = await agent(c, 'Claude writer', ['product'], claude.id);
await resetStaffing(c);
await c.staff({ product: { assignees: [writer], reviews: [] } });

const title = `C10 Claude ${Date.now().toString(36)}`;
const missionId = await c.createMission(title, { workflow: 'P2 solo' });
ev.note(`mission ${missionId}`);
await c.approvePlan(missionId, title);

/** Waits for doc to settle on Claude, answering any question it asks along the way. */
async function settle(pred, label) {
  const deadline = Date.now() + 25 * 60_000;
  for (;;) {
    const doc = await c.task(missionId, 'doc');
    if (pred(doc)) return doc;
    if (['FAILED', 'BLOCKED'].includes(doc.status)) return doc;
    const q = (await c.approvals(missionId, 'PENDING')).find((a) => a.taskId === doc.id && a.kind === 'choice');
    if (q) {
      const option = q.options.find((o) => /decide without me/i.test(o.label)) ?? q.options[q.options.length - 1];
      ev.note(`answered "${q.title}" with "${option.label}"`);
      await c.decideInInbox(q.title, { option: option.label, filter: 'For me' });
      await until(async () => (await api.get(`/v1/approvals/${q.id}`)).approval.status !== 'PENDING', { label: 'answered', timeoutMs: 15_000 });
    }
    if (Date.now() > deadline) throw new Error(`${label}: doc did not settle on Claude in 25 minutes`);
    await sleep(5000);
  }
}

const doc = await settle((t) => t.status === 'SUCCEEDED', 'round 1');
ev.check('round 1 finished on Claude Code', doc.status === 'SUCCEEDED' && doc.latestRun?.runtimeProfileId === claude.id, { status: doc.status, reason: doc.statusReason });
const note = 'Make the intro one sentence';
const sent = await c.requestChangesOnCard(missionId, 'doc', note);
noRecordingFor(ev, 'composer', sent.bodyWhileOpen);
ev.check('the flash says "Round 2 started"', sent.flash === 'Round 2 started', sent.flash);
const done = await settle((t) => t.round === 2 && t.status === 'SUCCEEDED', 'round 2');
ev.check('round 2 finished', done.status === 'SUCCEEDED' && done.round === 2, { status: done.status, round: done.round, reason: done.statusReason });

const runs = c.runs(doc.id);
ev.note(`runs: ${JSON.stringify(runs.map((r) => ({ round: r.round, purpose: r.purpose, status: r.status, session: r.sessionId })))}`);
const r1 = runs.filter((r) => r.round === 1 && r.status === 'SUCCEEDED').pop();
const r2 = runs.find((r) => r.round === 2 && r.purpose === 'round');
ev.check('every run is on the Claude profile', runs.length >= 2 && runs.every((r) => r.profileId === claude.id), runs.map((r) => r.profileId));
ev.check('the round-2 run continued round 1\'s session (same session id)', Boolean(r1?.sessionId) && r2?.sessionId === r1.sessionId, { r1: r1?.sessionId, r2: r2?.sessionId });
const thread = await c.feedback(doc.id);
const arts = c.sql("SELECT id, round, handoff FROM artifacts WHERE task_id = ? AND type = 'ProductSpec' AND withdrawn_at IS NULL ORDER BY created_at", doc.id);
const v2 = arts.filter((a) => a.round === 2).pop();
const handoff = v2 ? JSON.parse(v2.handoff ?? 'null') : null;
ev.check('the v2 handoff cites the note in changed', thread.items[0]?.status === 'addressed' && JSON.stringify(handoff?.changed ?? []).includes(thread.items[0].id), { changed: handoff?.changed, item: thread.items[0] });

// Reader: versions, Changes in v2, Compare with v1.
await page.navigate(`#/missions/${missionId}`); await sleep(1800);
await page.evaluate(`(() => { const card = document.querySelector('[data-feed-card="doc"]'); [...card.querySelectorAll('button')].find((x) => x.innerText.trim().startsWith('Full doc'))?.click(); })()`);
await until(async () => /Changes in v2/.test(await page.text('body')), { label: 'reader v2', timeoutMs: 15_000 }).catch(() => undefined);
await page.evaluate(`document.querySelectorAll('details.reader__change').forEach((d) => { d.open = true; })`);
await sleep(500);
const readerV2 = await page.text('body');
const versions = await page.evaluate(`[...document.querySelectorAll('.reader__version')].map((b) => b.innerText.trim())`);
ev.check('the reader has a version switcher v1, v2 and "Changes in v2" linked to the note', versions.includes('v1') && versions.includes('v2') && /Changes in v2/i.test(readerV2) && readerV2.includes(note), { versions });
await page.screenshot(ev.shot('reader-v2-changes'));
await page.evaluate(`[...document.querySelectorAll('.reader__version')].find((b) => b.innerText.trim() === 'v1')?.click()`);
await sleep(1500);
ev.check('switching to v1 opens the older version in place', /Older version/.test(await page.text('body')));
await page.screenshot(ev.shot('reader-v1'));
await page.evaluate(`[...document.querySelectorAll('.reader__version')].find((b) => b.innerText.trim() === 'v2')?.click()`);
await sleep(1500);
await page.evaluate(`[...document.querySelectorAll('button.reader__compare')].pop()?.click()`);
await sleep(1200);
const diff = await page.evaluate(`({ added: [...document.querySelectorAll('.diff__line--added')].map((x) => x.innerText), removed: [...document.querySelectorAll('.diff__line--removed')].map((x) => x.innerText), summary: document.querySelector('.diff__summary')?.innerText ?? '' })`);
ev.check('"Compare with v1" shows removed and added lines', diff.added.length > 0 && diff.removed.length > 0, { summary: diff.summary, added: diff.added.slice(0, 4), removed: diff.removed.slice(0, 4) });
await page.screenshot(ev.shot('reader-compare'));
await cancel(c, missionId, 'C10');
await resetStaffing(c);
// Later scenarios run on the scripted agent: take Claude out of routing again.
await api.patch(`/v1/runtimes/${claude.id}`, { enabled: false }).catch((e) => ev.note(`could not disable Claude: ${e.message}`));
c.close(); ev.save();
