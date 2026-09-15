// B11 — a design task on real Claude Code writes a valid handoff (within budget, or after one tighten pass),
// and its feed card reads as a short summary.
import { context, writeState } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';

const c = await context();
const { page, api, env, sleep, until } = c;
const ev = new Evidence('B11', 'Real Claude Code: handoff and short card');
let claude = (await api.get('/v1/runtimes')).map((r) => r.profile ?? r).find((p) => p.adapterId === 'claude-code');
if (!claude) {
  claude = await api.post('/v1/runtimes', { adapterId: 'claude-code', name: 'Claude Code', workspaceId: null, executablePath: `${process.env.HOME}/.local/bin/claude`, settings: { configDir: '~/.claude-home' }, maxConcurrent: 1, enabled: true });
  claude = claude.profile ?? claude;
}
const members = await c.team();
let agent = members.find((m) => m.name === 'Claude designer')?.id;
if (!agent) agent = (await api.post(`/v1/workspaces/${env.workspaceId}/members`, { kind: 'agent', name: 'Claude designer', reportsTo: c.me, roleIds: ['design'], runtimeProfileIds: [claude.id] })).id;
await api.patch(`/v1/workspaces/${env.workspaceId}/staffing`, { design: { assignees: [agent], reviews: [] }, product: { reviews: [] } });

const title = `B Claude ${Date.now().toString(36)}`;
const missionId = await c.createMission(title);
writeState({ b11: missionId });
await c.approvePlan(missionId, title);
const deadline = Date.now() + 25 * 60_000;
let design;
for (;;) {
  design = await c.task(missionId, 'design');
  if (['SUCCEEDED', 'AWAITING_APPROVAL', 'FAILED', 'BLOCKED'].includes(design.status)) break;
  const q = (await c.approvals(missionId, 'PENDING')).find((a) => a.taskId === design.id && a.kind === 'choice');
  if (q) {
    const option = q.options.find((o) => /brief|written|no design tool|without/i.test(`${o.label} ${o.description ?? ''}`) && !/decide without me/i.test(o.label)) ?? q.options.find((o) => /decide without me/i.test(o.label)) ?? q.options[q.options.length - 1];
    ev.note(`answered "${q.title}" with "${option.label}"`);
    await c.decideInInbox(q.title, { option: option.label, filter: 'For me' });
    await until(async () => (await api.get(`/v1/approvals/${q.id}`)).approval.status !== 'PENDING', { label: 'answered', timeoutMs: 15_000 });
  }
  if (Date.now() > deadline) throw new Error('design did not finish on Claude in 25 minutes');
  await sleep(5000);
}
ev.check('design finished on Claude Code', design.status === 'SUCCEEDED' && design.latestRun?.runtimeProfileId === claude.id, { status: design.status, runtime: design.runtimeName });
const art = (await api.get(`/v1/missions/${missionId}/artifacts`)).find((a) => a.taskId === design.id && a.type === 'DesignBrief');
ev.check('the DesignBrief has a valid handoff (headline ≤ 90, ≤ 3 points)', art?.handoff?.headline?.length > 0 && art.handoff.headline.length <= 90 && art.handoff.points.length <= 3, art?.handoff);
const events = await api.get(`/v1/missions/${missionId}/events?limit=1000`);
const tightens = (events.events ?? events).filter((e) => e.taskId === design.id && e.body?.type === 'artifact.tighten_requested').length;
ev.note(`words ${art?.wordCount}, overBudget ${art?.overBudget}, tighten passes ${tightens}`);
ev.check('within budget, or tightened once', art && (art.overBudget === false || tightens === 1), { words: art?.wordCount, tightens });
await page.navigate(`#/missions/${missionId}`); await sleep(1800);
await page.screenshot(ev.shot('feed'));
await page.evaluate(`(() => { const card = [...document.querySelectorAll('[class*=feedcard]')].find(e => e.innerText.includes('design') && e.innerText.includes('Full doc')); [...card.querySelectorAll('button,a')].find(b => b.innerText.trim().startsWith('Full doc'))?.click(); })()`);
await sleep(1500);
await page.screenshot(ev.shot('reader'));
await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: B11 proven' });
c.close(); ev.save();
