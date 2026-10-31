// H11 — Profile pinning. With two runtime profiles on the Design agent, a
// step held on one is continued on that same one, even after the agent no
// longer lists it: a session lives only under the profile it was made in.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { SCRIPTS, newMission, fakeProfile, holdFromCard, holdsOf, panelButton, panelLabel, useRuntimes, waitScreen, waitStep, shoot } from '../common.mjs';

const c = await context();
const { until } = c;
const ev = new Evidence('H11', 'Profile pinning: Continue resumes on the profile the hold was made on');
const a = await fakeProfile(c, 'Hold fake A', SCRIPTS.long);
const b = await fakeProfile(c, 'Hold fake B', SCRIPTS.long);
await useRuntimes(c, [a, b]);
ev.note('setup: the Design agent runs on two runtime profiles, A then B');

const missionId = await newMission(c, `Pinned onboarding ${Date.now().toString(36)}`, 'Hold one');
const running = await waitStep(c, missionId, (t) => t.status === 'RUNNING' && t.latestRun?.status === 'RUNNING', 'the step running', { timeoutMs: 90_000 });
const on = running.latestRun.runtimeProfileId;
const other = on === a ? b : a;
ev.check('proof (API): it runs on one of the two', [a, b].includes(on), { on, a, b });

await holdFromCard(c, missionId);
await waitScreen(c, 'Fake session').catch(() => '');
const [hold] = holdsOf(c, running.id);
ev.check('proof (DB): the hold is pinned to that profile', hold?.profileId === on, hold);

// The agent's profiles change while it is held: the other one now comes first, so routing alone would pick it.
await useRuntimes(c, [other, on]);
ev.check('setup: the Design agent now lists the other profile first', JSON.stringify((await c.team()).find((m) => m.name === 'Design agent').runtimeProfileIds) === JSON.stringify([other, on]));

const runsBefore = c.runs(running.id).map((r) => r.id);
await panelButton(c, 'Continue');
await until(async () => (await panelLabel(c)) === '', { label: 'panel closes', timeoutMs: 20_000 });
const done = await waitStep(c, missionId, (t) => ['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(t.status), 'the step settles', { timeoutMs: 120_000 });
const pass = c.runs(running.id).find((r) => !runsBefore.includes(r.id));
ev.check('the continuation finishes', done.status === 'SUCCEEDED', { status: done.status, reason: done.statusReason });
ev.check('proof (DB): Continue resumed on the hold\'s profile, not the one routing would pick now', pass?.profileId === on, { pass: pass?.profileId, pinned: on, other });
await shoot(c, ev, 'continued');
await useRuntimes(c, [await fakeProfile(c, 'Hold fake', SCRIPTS.long)]);
c.close(); ev.save();
