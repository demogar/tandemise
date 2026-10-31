// H7 — Hold a step that has not started. Two design steps share a one-slot
// runtime, so one runs and the other waits ready; holding the waiting one
// provisions its worktree and starts a fresh interactive session there.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { SCRIPTS, newMission, cardHold, fakeProfile, holdFromCard, holdsOf, panelButton, panelLabel, stepOf, typeLine, useRuntimes, waitScreen, waitStep, worktreeOf, shoot } from '../common.mjs';

const c = await context();
const { page, api, until, sleep } = c;
const ev = new Evidence('H7', 'Hold a ready step: a fresh session in a worktree made for it');
const single = await fakeProfile(c, 'Hold fake one slot', SCRIPTS.long, { maxConcurrent: 1 });
await useRuntimes(c, [single]);
ev.note('setup: both steps go to one fake runtime with a single slot');

const missionId = await newMission(c, `Two pages ${Date.now().toString(36)}`, 'Hold pair');
await until(async () => {
  const tasks = (await api.get(`/v1/missions/${missionId}`)).tasks;
  return tasks.some((t) => t.status === 'RUNNING') && tasks.some((t) => t.status === 'READY');
}, { label: 'one running, one ready', timeoutMs: 90_000 });
await sleep(1500);
const tasks = (await api.get(`/v1/missions/${missionId}`)).tasks;
const ready = tasks.find((t) => t.status === 'READY');
ev.check('proof (API): one step runs and the other waits ready, never started', ready !== undefined && ready.runCount === 0 && ready.holdable.ok === true, { status: ready?.status, reason: ready?.statusReason, holdable: ready?.holdable });
ev.check('proof (API): it has no worktree yet', (await worktreeOf(c, missionId, ready.id)) === null);

const button = await (async () => { await page.navigate(`#/missions/${missionId}`); await sleep(1500); return cardHold(c, ready.key); })();
ev.check('its card offers Hold', button?.text === 'Hold' && !button.disabled, button);
await holdFromCard(c, missionId, ready.key);
ev.check('Hold opens the terminal panel on it', (await panelLabel(c)) === `Terminal: ${ready.title}`);
const fresh = await waitScreen(c, 'Fake session').catch(() => '');
ev.check('a fresh session starts (nothing to resume)', fresh.includes('Fake session new'), fresh);
const [hold] = holdsOf(c, ready.id);
ev.check('proof (DB): a hold from READY, with no session before it', hold?.fromStatus === 'READY' && hold.sessionBefore === null, hold);

const worktree = await worktreeOf(c, missionId, ready.id);
ev.check('proof (API): its worktree was provisioned', typeof worktree === 'string' && existsSync(worktree), worktree);
await typeLine(c, 'write ready.txt');
await waitScreen(c, 'wrote ready.txt').catch(() => '');
ev.check('proof (disk): the session works in that worktree', worktree !== null && existsSync(join(worktree, 'ready.txt')));
await shoot(c, ev, 'fresh-session');

await panelButton(c, 'Release');
await until(async () => (await stepOf(c, missionId, ready.key)).hold === null, { label: 'released', timeoutMs: 20_000 });
ev.check('Release ends the hold and the panel closes', (await panelLabel(c)) === '' && (await stepOf(c, missionId, ready.key)).hold === null);
await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: H7 proven' });
await useRuntimes(c, [await fakeProfile(c, 'Hold fake', SCRIPTS.long)]);
c.close(); ev.save();
