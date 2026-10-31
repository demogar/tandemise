// H3 — Continue. From the panel: the hold ends, the step runs a resumed pass
// on the session the terminal captured, spends no attempt, and its output is
// harvested and gated as usual; task.hold_ended carries the diff stat.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { holdsOf, openFeed, panelButton, panelLabel, readState, stepOf, waitStep, shoot } from '../common.mjs';

const c = await context();
const { page, until } = c;
const ev = new Evidence('H3', 'Continue: a resumed pass on the captured session, no attempt spent, output gated as usual');
const { main: missionId, attemptsBeforeHold } = readState();
const step = await stepOf(c, missionId);
const runsBefore = c.runs(step.id).map((r) => r.id);
ev.check('the panel is open on the held step', (await panelLabel(c)) === `Terminal: ${step.title}` && step.status === 'HELD');

await panelButton(c, 'Continue');
await until(async () => (await panelLabel(c)) === '', { label: 'panel closes', timeoutMs: 20_000 });
ev.check('Continue ends the hold and the panel closes', (await panelLabel(c)) === '');

const done = await waitStep(c, missionId, (t) => ['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(t.status), 'the step settles', { timeoutMs: 120_000 });
ev.check('the step finishes', done.status === 'SUCCEEDED', { status: done.status, reason: done.statusReason });
ev.check('proof (API): continuing spent no attempt', done.attempts === attemptsBeforeHold, { before: attemptsBeforeHold, after: done.attempts });

const ended = holdsOf(c, step.id)[0];
ev.check('proof (DB): the hold ended as continued, and its continuation was taken', ended.ending === 'continued' && ended.endedAt !== null && ended.consumedAt !== null, ended);
const pass = c.runs(step.id).find((r) => !runsBefore.includes(r.id));
ev.check('proof (DB): one new pass ran', pass !== undefined && pass.status === 'SUCCEEDED', pass);
const resumedOn = pass === undefined ? [] : c.sql("SELECT body FROM run_events WHERE run_id = ? AND body LIKE '%session.resumed%'", pass.id).map((r) => JSON.parse(r.body));
ev.check('proof (DB): that pass resumed the session the terminal captured', typeof ended.sessionAfter === 'string' && resumedOn.some((b) => JSON.stringify(b).includes(ended.sessionAfter)), { sessionAfter: ended.sessionAfter, resumedOn });

const events = await c.events(missionId);
const holdEnded = events.find((e) => (e.body?.type ?? e.type) === 'task.hold_ended' && e.taskId === step.id);
const body = holdEnded?.body ?? holdEnded;
ev.check('proof (API): task.hold_ended carries the diff stat (d.txt added)', (body?.diffStat?.files ?? 0) >= 1 && body.diffStat.insertions >= 1, body?.diffStat ?? holdEnded);
ev.check('proof (API): and who held it, from where, the sessions and how long', body?.ending === 'continued' && typeof body?.durationMs === 'number' && body?.sessionAfter === ended.sessionAfter, body);

const artifacts = (await c.api.get(`/v1/missions/${missionId}/artifacts`)).filter((a) => a.taskId === step.id);
ev.check('proof (API): the continuation\'s DesignBrief was harvested', artifacts.some((a) => a.type === 'DesignBrief' && a.createdByRunId === pass?.id), artifacts.map((a) => ({ type: a.type, run: a.createdByRunId })));
ev.check('proof (API): and gated as usual', done.gate === null || done.gate?.passed === true, done.gate);
ev.check('proof (API): a finished step is no longer holdable, in words', done.holdable.ok === false && done.holdable.reason === 'This step is done; request changes instead.', done.holdable);

await openFeed(c, missionId);
await shoot(c, ev, 'done');
c.close(); ev.save();
