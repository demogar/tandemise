// H6 — Hold a step waiting on its own question. The agent asks you through
// ask_human (over its run's real MCP gateway); the question shows in the
// Inbox; you hold the step from its drawer instead of answering, and the
// question card leaves the Inbox: you answer in the terminal now.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { SCRIPTS, newMission, askHuman, fakeProfile, holdFromDrawer, mcpConfigOf, panelButton, panelLabel, stepOf, useRuntimes, waitScreen, waitStep, shoot } from '../common.mjs';

const c = await context();
const { page, api, until } = c;
const ev = new Evidence('H6', 'Hold a step waiting on ask_human: its question leaves the Inbox');
await useRuntimes(c, [await fakeProfile(c, 'Hold fake', SCRIPTS.long)]);

const missionId = await newMission(c, `Ask about onboarding ${Date.now().toString(36)}`, 'Hold one');
const running = await waitStep(c, missionId, (t) => t.status === 'RUNNING' && t.latestRun?.status === 'RUNNING' && t.now?.startsWith('Editing'), 'the step at work', { timeoutMs: 90_000 });
const config = mcpConfigOf(c.env.home, running.latestRun.id);
ev.check('setup: the run\'s MCP gateway config is on disk', config !== null);

const question = `Which layout should onboarding use (${Date.now().toString(36)})?`;
const caller = await askHuman(config, question);
const asked = await waitStep(c, missionId, (t) => t.status === 'AWAITING_INPUT', 'the step waiting on its question', { timeoutMs: 20_000 });
const card = (await c.approvals(missionId, 'PENDING')).find((a) => a.kind === 'choice' && a.taskId === asked.id);
ev.check('proof (API): the step waits on its question, a question card pending', asked.status === 'AWAITING_INPUT' && card !== undefined, { status: asked.status, card: card?.title });
// What waits on you is above "Decided"; a withdrawn question moves down there, marked as withdrawn.
const waitingPart = (text) => text.split(/\nDecided\b/)[0];
const inboxBefore = await until(async () => { const t = await c.ui.inbox('Everyone'); return waitingPart(t).includes(question.slice(0, 40)) && t; }, { label: 'question in the Inbox', timeoutMs: 20_000 }).catch(() => c.ui.inbox('Everyone'));
ev.check('the question waits on you in the Inbox', waitingPart(inboxBefore).includes(question.slice(0, 40)), waitingPart(inboxBefore).slice(0, 400));
await shoot(c, ev, 'inbox-question');

await holdFromDrawer(c, missionId, asked.title);
ev.check('Hold from its drawer opens the terminal panel', (await panelLabel(c)) === `Terminal: ${asked.title}`);
const screen = await waitScreen(c, 'Fake session').catch(() => '');
ev.check('the session is resumed in the terminal, to answer there', screen.includes('Fake session sess-hold-'), screen);
const held = await stepOf(c, missionId);
ev.check('proof (API): the step is HELD', held.status === 'HELD', held.status);
const closed = (await api.get(`/v1/approvals/${card.id}`)).approval;
ev.check('proof (API): the question card was withdrawn', closed.status !== 'PENDING', closed.status);
caller.kill();

await panelButton(c, 'Close terminal');
const inboxAfter = await until(async () => { const t = await c.ui.inbox('Everyone'); return !waitingPart(t).includes(question.slice(0, 40)) && t; }, { label: 'question gone', timeoutMs: 20_000 }).catch(() => c.ui.inbox('Everyone'));
ev.check('the question no longer waits on you in the Inbox', !waitingPart(inboxAfter).includes(question.slice(0, 40)), waitingPart(inboxAfter).slice(0, 400));
ev.check('it is listed as decided: withdrawn because the work moved on', /Withdrawn/.test(inboxAfter.split(question.slice(0, 40))[1] ?? ''), (inboxAfter.split(question.slice(0, 40))[1] ?? '').slice(0, 120));
await shoot(c, ev, 'inbox-after');

// Cleanup: the hold released from the drawer, and the mission cancelled.
await c.openTaskDrawer(missionId, held.title);
await page.evaluate(`[...document.querySelectorAll('.modal .modal__foot button')].find((b) => b.innerText.trim() === 'Release')?.click()`);
await until(async () => (await stepOf(c, missionId)).hold === null, { label: 'released', timeoutMs: 20_000 });
ev.check('Release in the drawer ends the hold', (await stepOf(c, missionId)).hold === null);
await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: H6 proven' });
c.close(); ev.save();
