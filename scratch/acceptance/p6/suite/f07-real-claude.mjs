// F7 — The real product agent: Claude Code refines a rough request for the acceptance project. Proves the Refinement
// contract holds for a real model (parsed, within limits) and records what it proposed and asked, for a person to judge.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { createDraft, rowsOf, sectionText, planButton, cancel } from '../common.mjs';

const c = await context();
const { page, api, until, sleep, env } = c;
const ev = new Evidence('F7', 'Real runtime: Claude Code refines a rough request');

// Setup (API): a Claude Code profile, and the product role routed to it for this scenario only.
let claude = (await api.get('/v1/runtimes')).map((r) => r.profile ?? r).find((p) => p.adapterId === 'claude-code');
if (!claude) {
  claude = await api.post('/v1/runtimes', { adapterId: 'claude-code', name: 'Claude Code', workspaceId: null, executablePath: `${process.env.HOME}/.local/bin/claude`, settings: { configDir: '~/.claude-home' }, maxConcurrent: 1, enabled: true });
  claude = claude.profile ?? claude;
}
const routing = (await api.get(`/v1/workspaces/${env.workspaceId}`)).workspace.routing ?? {};
await api.patch(`/v1/workspaces/${env.workspaceId}`, { routing: { ...routing, product: [claude.id] } });

try {
  const goal = 'Make the README useful for someone new to this project';
  const { id: missionId } = await createDraft(c, goal);
  ev.note(`mission ${missionId}`);
  await page.click('Refine', { within: 'section[aria-label="Get it ready"]' });
  const view = await until(async () => { const v = await api.get(`/v1/missions/${missionId}/refinement`); return v.state !== 'running' && v; }, { label: 'real refinement', timeoutMs: 12 * 60_000, everyMs: 3000 });
  await sleep(1500);
  ev.check('the real pass finished and was accepted by the contract', view.state === 'idle' && typeof view.artifactId === 'string', { state: view.state, failure: view.failure });
  const proposed = view.criteria.filter((x) => x.status === 'proposed');
  const open = view.questions.filter((q) => q.status === 'open');
  ev.check('it proposed between 1 and 8 criteria', proposed.length >= 1 && proposed.length <= 8, proposed.length);
  ev.check('it asked at most 5 questions', open.length <= 5, open.length);
  for (const p of proposed) ev.note(`${p.key}: ${p.statement}`);
  for (const q of open) ev.note(`${q.key}: ${q.text} | why: ${q.why} | options: ${q.options.join(' / ')}`);
  const rows = await rowsOf(c, 'Proposed criteria');
  ev.check('each proposal is on screen with Accept and Reject', rows.length === proposed.length && rows.every((r) => r.includes('Accept') && r.includes('Reject')), rows);
  const plan = await planButton(c);
  ev.check('the Plan button says what is left', plan?.disabled === true && /to plan$/.test(plan.text), plan);
  ev.note(`headline: ${view.headline}`);
  ev.note(`panel: ${(await sectionText(c, 'Get it ready')).replace(/\s+/g, ' ').slice(0, 300)}`);
  await page.screenshot(ev.shot('real-refinement'));
  await cancel(c, missionId, 'F7');
} finally {
  await api.patch(`/v1/workspaces/${env.workspaceId}`, { routing });
}
c.close(); ev.save();
