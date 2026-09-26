// C1 — Tweak a finished doc: Request changes on the card, no dependents, round 2 continues the session and cites the note.
// Runs on the daemon's built-in fake runtime, which declares session_resume (plan ruling 19); the scripted generic CLI cannot resume.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { assertSolo, noRecordingFor, agent, resetStaffing, waitTask, cancel } from '../common.mjs';

const c = await context();
const { page, api, sleep } = c;
const ev = new Evidence('C1', 'Tweak a finished doc: round 2 continues the session and cites the note');
await assertSolo(c, ev);

const spec = (headline, changed) => ['---', 'type: ProductSpec', 'schemaVersion: 1', 'title: Hello spec', 'handoff:', `  headline: ${headline}`,
  '  points:', '    - Written by the fake runtime',
  ...(changed ? ['  changed:', '    - what: "Shortened the intro"', '      feedback: "{{fb}}"'] : []),
  // Covers the one Done-when line every mission now carries (P6), as the ledger requires of a spec.
  'acceptanceCriteria:', '  - id: AC1', '    statement: The page greets the visitor.', '    covers: [U1]', 'nonGoals: []', '---', '', `# Hello\n\n${headline}.`].join('\n');
const fake = await api.post('/v1/runtimes', {
  adapterId: 'fake', name: `Fake rounds ${Date.now().toString(36)}`, workspaceId: null, enabled: true, maxConcurrent: 2,
  settings: { script: { captures: { fb: '^\\d+\\. (fb_[0-9a-z]{20}) \\(' }, steps: [
    { kind: 'checkpoint', sessionId: 'c1-session', label: 'session.init' },
    { kind: 'write-file', path: '.tandemise/out/ProductSpec.md', content: spec('A hello page with a long intro') },
    { kind: 'write-file', path: '.tandemise/out/ProductSpec.md', content: spec('A hello page with a short intro', true), when: { promptIncludes: 'Feedback to address' } },
    { kind: 'complete', summary: 'done' },
  ] } },
});
const fakeId = (fake.profile ?? fake).id;
const writer = await agent(c, 'C1 writer', ['product'], fakeId);
await resetStaffing(c);
await c.staff({ product: { assignees: [writer], reviews: [] } });

const title = `C1 tweak ${Date.now().toString(36)}`;
const missionId = await c.createMission(title, { workflow: 'P2 solo' });
ev.note(`mission ${missionId}`);
await c.approvePlan(missionId, title);
const doc = await waitTask(c, missionId, 'doc', (t) => t.status === 'SUCCEEDED', 'doc done', 60_000);
ev.check('round 1 ran on the fake runtime', doc.latestRun?.runtimeProfileId === fakeId && doc.round === 1, { profile: doc.latestRun?.runtimeProfileId, round: doc.round });

await page.navigate(`#/missions/${missionId}`); await sleep(1500);
const before = await c.cardText('doc');
ev.check('the done card offers Request changes', /Request changes/.test(before), before);
await page.screenshot(ev.shot('card-done'));
const sent = await c.requestChangesOnCard(missionId, 'doc', 'Shorter intro', { shot: ev.shot('composer') });
noRecordingFor(ev, 'composer', sent.bodyWhileOpen);
ev.check('the composer asks "What should change?" and has no About for a single output', /What should change\?/.test(sent.composer) && !/About/.test(sent.composer), sent.composer);
ev.check('no dependents: no impact dialog, the flash says "Round 2 started"', sent.flash === 'Round 2 started' && (await c.dialogText('Round ')) === '', sent.flash);
await page.screenshot(ev.shot('flash'));

const done2 = await waitTask(c, missionId, 'doc', (t) => t.round === 2 && t.status === 'SUCCEEDED', 'round 2 done', 60_000);
const thread = await c.feedback(doc.id);
ev.check('the note is addressed in round 2', thread.items.length === 1 && thread.items[0].status === 'addressed' && thread.items[0].round === 2 && thread.items[0].text === 'Shorter intro', thread.items);
const runs = c.runs(doc.id);
ev.check('round 2 ran on the same session', done2.latestRun?.purpose === 'round' && done2.latestRun.round === 2 && done2.latestRun.externalSessionId === 'c1-session', runs);
ev.check('both rounds are runs on the same fake profile and session', runs.length === 2 && runs.every((r) => r.profileId === fakeId && r.sessionId === 'c1-session') && runs[1].round === 2, runs);
// The session id alone could be the script repeating itself; the runtime saying it resumed is the proof.
const resumed = (await c.events(missionId)).filter((e) => e.runId === done2.latestRun.id && e.body.type === 'checkpoint').map((e) => e.body.label);
ev.check('the round-2 run resumed the session rather than starting a new one', resumed[0] === 'session.resumed', resumed);

await page.navigate(`#/missions/${missionId}`); await sleep(1800);
const card = await c.cardText('doc');
ev.check('the card shows Round 2 and What changed citing the note\'s author, with no ids', /Round 2/.test(card) && /What changed/i.test(card) && /Shortened the intro\s*·\s*You/.test(card) && !/fb_/.test(card), card);
noRecordingFor(ev, 'feed', await page.text('body'));
await page.screenshot(ev.shot('card-round-2'));

await cancel(c, missionId, 'C1');
// Later scenarios run on the scripted agent: take the fake profile out of routing.
await api.patch(`/v1/runtimes/${fakeId}`, { enabled: false }).catch((e) => ev.note(`could not disable the fake profile: ${e.message}`));
await resetStaffing(c);
c.close(); ev.save();
