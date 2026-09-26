// One mission run by you and your agents: A2, A3, A8, A9 and A13, all decided in the window.
// A4, A6 and A7 needed a second person and are retired (see the suite README); A2d and A7q take their place.
import { context, writeState } from '../lib/ctx.mjs';
import { Evidence } from '../lib/evidence.mjs';

const c = await context();
const { page, api, ui, sleep, until } = c;
const id = {};
for (const n of ['Product agent', 'Design agent', 'Architecture agent', 'Coding agent', 'QA agent', 'Finance agent', 'Release agent']) id[n] = await c.id(n);
const title = `Team hello ${Date.now().toString(36)}`;
const missionId = await c.createMission(title);
writeState({ team: missionId });
const pendingFor = async (key, kind) => { const t = await c.task(missionId, key); return (await c.approvals(missionId, 'PENDING')).filter((a) => a.taskId === t.id && (kind ? a.kind === kind : a.kind !== 'check')); };

await c.approvePlan(missionId, title);
{
  const ev = new Evidence('PLAN', 'Before anything runs, the Plan says who will do each task');
  await page.navigate(`#/missions/${missionId}/plan`); await sleep(1500);
  const plan = await page.text('main');
  ev.check('build: Coding agent, responsible you', /Coding agent[\s\S]{0,60}Responsible\s*You/.test(plan));
  ev.check('design: Design agent, responsible you', /Design agent[\s\S]{0,60}Responsible\s*You/.test(plan));
  ev.check('qa: QA agent, responsible you', /QA agent[\s\S]{0,60}Responsible\s*You/.test(plan));
  await page.screenshot(ev.shot('plan'));
  ev.save();
}

// ---- A2: product agent drafts, you approve from For me.
{
  const ev = new Evidence('A2', 'AI drafts, you approve');
  const [apr] = await until(async () => { const a = await pendingFor('spec'); return a.length && a; }, { label: 'spec approval', timeoutMs: 60_000 });
  ev.check('spec approval addressed to you only', JSON.stringify(apr.addressees) === JSON.stringify([c.me]), apr.addressees);
  const forMe = await ui.inbox('For me');
  ev.check('listed under For me as "For you"', /Approve the output of spec\?[^\n]*\n(?:[^\n]*\n)?\s*For you/.test(forMe));
  await page.screenshot(ev.shot('inbox'));
  await ui.openItem('Approve the output of spec?', 'For me');
  const card = await page.text('main');
  ev.check('evidence names the artifact by title, not by id', /ProductSpec: /.test(card) && !/\bart_[a-z0-9]{12,}/.test(card.slice(card.indexOf('EVIDENCE'), card.indexOf('YOUR OPTIONS'))));
  await page.screenshot(ev.shot('card'));
  await c.decideInInbox('Approve the output of spec?', { filter: 'For me' });
  await until(async () => (await c.task(missionId, 'spec')).status === 'SUCCEEDED', { label: 'spec done' });
  const decided = (await c.approvals(missionId)).find((a) => a.id === apr.id);
  ev.check('decided by you', decided.decidedBy === c.me);
  const started = await until(async () => { const ts = await c.tasks(missionId); return ['design', 'architecture', 'finance'].filter((k) => ts[k].status !== 'PENDING').length === 3 && ts; }, { label: 'downstream' });
  ev.check('approving released the next tasks', true, ['design', 'architecture', 'finance', 'docs'].map((k) => `${k}:${started[k].status}`));
  ev.save();
}

// ---- Design by your Design agent is yours to approve too. (A4 and A6 - a teammate's approval, recorded on
// their behalf - need a second person and were retired with "Add person" in 0.4.0; see the suite README.)
{
  const ev = new Evidence('A2d', 'Your agent\'s design is yours to approve');
  const [apr] = await until(async () => { const a = await pendingFor('design'); return a.length && a; }, { label: 'design approval', timeoutMs: 60_000 });
  const design = await c.task(missionId, 'design');
  ev.check('done by your Design agent; responsible you', design.assignee?.id === id['Design agent'] && design.responsible?.id === c.me, { assignee: design.assignee?.name, responsible: design.responsible?.name });
  ev.check('addressed to you only', JSON.stringify(apr.addressees) === JSON.stringify([c.me]), apr.addressees);
  ev.check('listed under For me as "For you"', /Approve the output of design\?[^\n]*\n(?:[^\n]*\n)?\s*For you/.test(await ui.inbox('For me')));
  await ui.openItem('Approve the output of design?', 'For me');
  const card = await page.text('main');
  ev.check('no "Recording for" on your own decision', !card.includes('Recording for'));
  await page.screenshot(ev.shot('card'));
  await c.decideInInbox('Approve the output of design?', { filter: 'For me' });
  await until(async () => (await c.task(missionId, 'design')).status === 'SUCCEEDED', { label: 'design done' });
  const decided = (await c.approvals(missionId)).find((a) => a.id === apr.id);
  ev.check('decided by you, on your own behalf', decided.decidedBy === c.me && (decided.recordedBy ?? c.me) === c.me, { decidedBy: decided.decidedBy, recordedBy: decided.recordedBy });
  ev.save();
}

// ---- A8: checked later; nothing waits. "Needs changes" with a note is feedback (P2 spec §10): work that used
// the output is asked about first, and "Keep their work" leaves it standing and flags it when round 2 lands.
{
  const ev = new Evidence('A8', 'AI drafts, you check later');
  const arch = await until(async () => { const t = await c.task(missionId, 'architecture'); return t.status === 'SUCCEEDED' && t; }, { label: 'architecture done' });
  const [check] = await pendingFor('architecture', 'check');
  ev.check('architecture finished without waiting; a check card is open for you', arch.status === 'SUCCEEDED' && JSON.stringify(check?.addressees) === JSON.stringify([c.me]));
  const build = await until(async () => { const t = await c.task(missionId, 'build'); return t.status !== 'PENDING' && t; }, { label: 'build started', timeoutMs: 90_000 });
  ev.check('build went ahead while the check was open', ['READY', 'RUNNING', 'SUCCEEDED'].includes(build.status), build.status);
  // Build has to have used architecture v1 for the question to exist.
  const built = await until(async () => { const t = await c.task(missionId, 'build'); return t.status === 'SUCCEEDED' && t; }, { label: 'build done', timeoutMs: 120_000 });
  await ui.openItem('Check architecture when you can', 'For me');
  await page.screenshot(ev.shot('check-card'));
  await c.decideInInbox('Check architecture when you can', { filter: 'For me', option: 'Needs changes', note: 'Split the page into a server component and a client greeting.', confirm: false });
  const dialog = await until(() => page.evaluate(`[...document.querySelectorAll('[role=dialog]')].map((d) => d.innerText).find((t) => t.startsWith('Round 2 of')) ?? ''`), { label: 'impact dialog', timeoutMs: 15_000 }).catch(() => '');
  ev.check('the Inbox opens the impact dialog: build used architecture v1', /Build \(done\)[^.]*used Architecture v1/.test(dialog), dialog);
  await page.screenshot(ev.shot('impact-dialog'));
  const chose = await page.evaluate(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].pop(); const i = d && [...d.querySelectorAll('label')].find((x) => x.innerText.trim().startsWith('Keep their work'))?.querySelector('input'); if (!i) return false; i.click(); return true; })()`);
  await sleep(300);
  const started = chose && await page.evaluate(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].pop(); const b = d && [...d.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Start round 2' && !x.disabled); if (!b) return false; b.click(); return true; })()`);
  ev.check('chose "Keep their work" and started round 2', Boolean(started));
  const round2 = await until(async () => { const t = await c.task(missionId, 'architecture'); return t.round === 2 && t; }, { label: 'architecture round 2', timeoutMs: 15_000 }).catch(async () => c.task(missionId, 'architecture'));
  ev.check('architecture starts round 2', round2.round === 2, { round: round2.round, status: round2.status });
  const kept = await c.task(missionId, 'build');
  ev.check('build was not stopped or redone', kept.status === 'SUCCEEDED' && kept.latestRun?.id === built.latestRun?.id, kept.status);
  await until(async () => { const t = await c.task(missionId, 'architecture'); return t.round === 2 && t.status === 'SUCCEEDED' && t; }, { label: 'architecture round 2 lands', timeoutMs: 90_000 });
  const flagged = await until(async () => { const t = await c.task(missionId, 'build'); return t.needsAttention && t; }, { label: 'build flagged', timeoutMs: 15_000 }).catch(async () => c.task(missionId, 'build'));
  ev.check('once architecture round 2 lands, build is flagged for attention', flagged.needsAttention === true && flagged.status === 'SUCCEEDED', { needsAttention: flagged.needsAttention, status: flagged.status });
  await page.navigate(`#/missions/${missionId}/plan`); await sleep(1500);
  await page.screenshot(ev.shot('plan-attention'));
  ev.save();
}

// ---- A9 (low risk) and A3.
{
  const ev = new Evidence('A9a', 'Safety net: a low-risk task needs no approval');
  const fin = await until(async () => { const t = await c.task(missionId, 'finance'); return t.status === 'SUCCEEDED' && t; }, { label: 'finance done' });
  ev.check('finance succeeded with no approval card', (await c.approvals(missionId)).every((a) => a.taskId !== fin.id));
  const events = await api.get(`/v1/missions/${missionId}/events?limit=1000`);
  const skipped = (events.events ?? events).find((e) => e.body?.type === 'review.skipped' && e.taskId === fin.id);
  ev.check('timeline records the skipped review with task.risk_level below 2', skipped && skipped.body.facts['task.risk_level'] < 2, skipped?.body);
  ev.save();

  const a3 = new Evidence('A3', 'You do a stage yourself');
  const docs = await until(async () => { const t = await c.task(missionId, 'docs'); return t.status === 'AWAITING_HUMAN' && t; }, { label: 'docs waiting' });
  a3.check('docs is assigned to you (the only owner)', docs.assignee?.id === c.me, docs.assignee);
  await ui.openTask('docs', title, 'For me');
  await page.fill('Paste what you produced', 'README: the hello page greets visitors by name.');
  await page.click('Mark done');
  const done = await until(async () => { const t = await c.task(missionId, 'docs'); return t.status === 'SUCCEEDED' && t; }, { label: 'docs done' });
  const art = (await api.get(`/v1/missions/${missionId}/artifacts`)).find((a) => a.taskId === done.id);
  a3.check('artifact by you, responsible you, readable text', art?.author?.id === c.me && art?.responsible?.id === c.me && art?.mediaType === 'text/markdown', { author: art?.author?.name, mediaType: art?.mediaType });
  a3.save();
}

// ---- qa runs on your QA agent. (A7 - a pool of people claiming a step - was retired with the people
// presets in 0.4.0; see the suite README.)
{
  const ev = new Evidence('A7q', 'QA runs on the agent staffed first');
  const qa = await until(async () => { const t = await c.task(missionId, 'qa'); return t.status === 'SUCCEEDED' && t; }, { label: 'qa done', timeoutMs: 120_000 });
  ev.check('qa ran on the QA agent (first in its staffing), responsible you', qa.assignee?.id === id['QA agent'] && qa.responsible?.id === c.me && qa.claimable.length === 0, { assignee: qa.assignee?.name, responsible: qa.responsible?.name });
  const art = (await api.get(`/v1/missions/${missionId}/artifacts`)).find((a) => a.taskId === qa.id);
  ev.check('QAPlan by the QA agent, you responsible', art?.author?.id === id['QA agent'] && art?.responsible?.id === c.me, { author: art?.author?.name });
  ev.save();
}

// ---- A9 (external side effect) and A13.
{
  const ev = new Evidence('A9b', 'Safety net: a task with an external side effect needs an approval');
  const [apr] = await until(async () => { const a = await pendingFor('release'); return a.length && a; }, { label: 'release approval', timeoutMs: 90_000 });
  ev.check('release approval addressed to you', JSON.stringify(apr.addressees) === JSON.stringify([c.me]));
  await page.navigate(`#/missions/${missionId}/plan`); await sleep(1200);
  ev.check('mission banner: "1 decision waiting on you. Approve the output of release?"', /decision waiting on you\.\s*Approve the output of release\?/.test(await page.text('main')));
  await page.screenshot(ev.shot('banner'));
  await c.decideInInbox('Approve the output of release?', { filter: 'For me' });
  const m = await until(async () => { const x = (await api.get(`/v1/missions/${missionId}`)).mission; return ['COMPLETE', 'BLOCKED', 'FAILED'].includes(x.status) && x; }, { label: 'mission end', timeoutMs: 60_000 });
  ev.check('approved (after the release-class confirmation) → mission COMPLETE', m.status === 'COMPLETE', m.status);
  ev.save();

  const a13 = new Evidence('A13', 'Beyond design: code, finance and release follow the same rules');
  const ts = await c.tasks(missionId);
  const arts = await api.get(`/v1/missions/${missionId}/artifacts`);
  const change = arts.find((a) => a.type === 'ChangeSet');
  const fin = arts.find((a) => a.type === 'FinanceReport');
  a13.check('ChangeSet by your Coding agent, you responsible', ts.build.assignee?.id === id['Coding agent'] && change?.author?.id === id['Coding agent'] && change?.responsible?.id === c.me);
  a13.check('FinanceReport by your Finance agent, you responsible', fin?.author?.id === id['Finance agent'] && fin?.responsible?.id === c.me);
  a13.check('ReleaseCandidate by your Release agent, you responsible', ts.release.assignee?.id === id['Release agent'] && ts.release.responsible?.id === c.me);
  await page.navigate(`#/missions/${missionId}/plan`); await sleep(1500);
  await page.screenshot(a13.shot('plan-complete'));
  a13.save();
}
c.close();
