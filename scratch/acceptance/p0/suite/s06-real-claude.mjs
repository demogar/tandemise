// A15 — Ana's agent on the real Claude Code runtime: same addressing and attribution as the scripted run.
import { context, writeState } from '../lib/ctx.mjs';
import { Evidence } from '../lib/evidence.mjs';

const c = await context();
const { page, api, sleep, until } = c;
const ana = await c.id('Ana Ruiz'); const figma = await c.id('Figma design agent');
const ev = new Evidence('A15', "Real runtime: Ana's agent on Claude Code");

let claude = (await api.get('/v1/runtimes')).map((r) => r.profile ?? r).find((p) => p.adapterId === 'claude-code');
if (!claude) {
  // Setup: the same account setting the user's own installation uses.
  claude = await api.post('/v1/runtimes', { adapterId: 'claude-code', name: 'Claude Code', workspaceId: null, executablePath: `${process.env.HOME}/.local/bin/claude`, settings: { configDir: '~/.claude-home' }, maxConcurrent: 1, enabled: true });
  claude = claude.profile ?? claude;
}

await page.navigate('#/team'); await sleep(900);
await page.evaluate(`[...document.querySelectorAll('button')].find(x => x.offsetParent && x.innerText.trim().replace(/\\s+/g,' ').startsWith('Figma design agent Agent'))?.click()`);
await sleep(700);
if ((await page.evaluate(`[...document.querySelectorAll('button')].find(b => b.offsetParent && b.innerText.trim() === 'Claude Code')?.getAttribute('aria-pressed')`)) !== 'true') {
  if (await page.evaluate(`[...document.querySelectorAll('button')].some(b => b.offsetParent && b.innerText.trim() === 'Claude Code')`)) await page.click('Claude Code');
}
await sleep(300);
await page.evaluate(`(() => { const bs = [...document.querySelectorAll('button[aria-label="Remove runtime"]')].filter(b => b.offsetParent); const t = bs.find(b => { let n = b; for (let i = 0; i < 4 && n; i++) { n = n.parentElement; if (n && /Scripted agent/.test(n.innerText) && !/Claude Code/.test(n.innerText)) return true; } return false; }); t?.click(); })()`);
await sleep(300);
await page.screenshot(ev.shot('agent-drawer'));
await page.click('Save');
ev.check("Ana's agent runs on Claude Code only (set in its drawer)", Boolean(await until(async () => (await c.team()).find((m) => m.id === figma && JSON.stringify(m.runtimeProfileIds) === JSON.stringify([claude.id])), { label: 'agent on claude', timeoutMs: 8000 })));

const title = `Real Claude ${Date.now().toString(36)}`;
const missionId = await c.createMission(title);
writeState({ claude: missionId });
await c.approvePlan(missionId, title);
await until(async () => (await c.approvals(missionId, 'PENDING')).some((a) => a.title === 'Approve the output of spec?'), { label: 'spec approval', timeoutMs: 90_000 });
await c.decideInInbox('Approve the output of spec?', { filter: 'For me' });

// Claude may ask its responsible person a question. Answer as Ana, avoiding anything that creates things outside this machine.
const deadline = Date.now() + 20 * 60_000;
let design;
for (;;) {
  design = await c.task(missionId, 'design');
  if (['AWAITING_APPROVAL', 'FAILED', 'BLOCKED', 'SUCCEEDED'].includes(design.status)) break;
  const question = (await c.approvals(missionId, 'PENDING')).find((a) => a.taskId === design.id && a.kind === 'choice');
  if (question) {
    ev.check(`Claude's question "${question.title}" is addressed to Ana only`, JSON.stringify(question.addressees) === JSON.stringify([ana]), question.addressees);
    const option = question.options.find((o) => /brief|written|no design tool|without/i.test(`${o.label} ${o.description ?? ''}`) && !/decide without me/i.test(o.label)) ?? question.options.find((o) => /decide without me/i.test(o.label)) ?? question.options[question.options.length - 1];
    await page.screenshot(ev.shot('question'));
    await c.decideInInbox(question.title, { option: option.label, recordingFor: 'Ana Ruiz' });
    const answered = await until(async () => { const a = (await api.get(`/v1/approvals/${question.id}`)).approval; return a.status !== 'PENDING' && a; }, { label: 'answered', timeoutMs: 15_000 });
    ev.check('answer recorded as Ana, by you', answered.decidedBy === ana && answered.recordedBy === c.me, { option: answered.selectedOptionId });
  }
  if (Date.now() > deadline) throw new Error('design did not finish on Claude in 20 minutes');
  await sleep(5000);
}
ev.check('design finished its Claude run and waits for review', design.status === 'AWAITING_APPROVAL', { status: design.status, reason: design.statusReason });
ev.check('the run used Claude Code', design.latestRun?.runtimeProfileId === claude.id, design.runtimeName);
ev.check("done by Ana's agent; Ana responsible", design.assignee?.id === figma && design.responsible?.id === ana);
const art = (await api.get(`/v1/missions/${missionId}/artifacts`)).find((a) => a.taskId === design.id);
ev.check("DesignBrief by Ana's agent, Ana responsible", art?.author?.id === figma && art?.responsible?.id === ana, { title: art?.title, bytes: art?.byteSize });
const [apr] = (await c.approvals(missionId, 'PENDING')).filter((a) => a.taskId === design.id && a.kind !== 'check');
ev.check('review addressed to Ana only', JSON.stringify(apr?.addressees) === JSON.stringify([ana]));
const events = await api.get(`/v1/missions/${missionId}/events?limit=1000`);
const runEvents = (events.events ?? events).filter((e) => e.taskId === design.id && e.runId);
ev.check("every event of the run carries Ana's agent as actor", runEvents.length > 0 && runEvents.every((e) => e.actorId === figma), { events: runEvents.length, actors: [...new Set(runEvents.map((e) => e.actorId))] });
await page.navigate(`#/missions/${missionId}/plan`); await sleep(1500);
await page.screenshot(ev.shot('plan'));
await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: A15 proven' });
c.close(); ev.save();
