// C11 — Beyond docs: Request changes on a ChangeSet under review; round 2 edits the same branch and the review reruns.
import { execFileSync } from 'node:child_process';
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { assertSolo, noRecordingFor, resetStaffing, waitTask, cancel } from '../common.mjs';

const c = await context();
const { page, api, ui, env, sleep, until } = c;
const ev = new Evidence('C11', 'Beyond docs: a code round edits the same branch and the review reruns');
await assertSolo(c, ev);
await resetStaffing(c);
await c.staff({ development: { assignees: [], reviews: [{ by: 'responsible', mode: 'blocking', when: 'always' }] } });

const title = `C11 code ${Date.now().toString(36)}`;
const missionId = await c.createMission(title, { workflow: 'P2 chain' });
ev.note(`mission ${missionId}`);
await c.approvePlan(missionId, title);
const build = await waitTask(c, missionId, 'build', (t) => t.status === 'AWAITING_APPROVAL', 'build in review', 120_000);
const [card] = (await c.approvals(missionId, 'PENDING')).filter((a) => a.taskId === build.id);
ev.check('a review card is open on build for you', Boolean(card) && JSON.stringify(card.addressees) === JSON.stringify([c.me]), card?.title);
const refsOf = async (artifactId) => (await api.get(`/v1/artifacts/${artifactId}`)).manifest.sourceRefs;
const changeSets = () => c.sql("SELECT id, round, created_at FROM artifacts WHERE task_id = ? AND type = 'ChangeSet' AND withdrawn_at IS NULL ORDER BY created_at", build.id);
const [cs1] = changeSets();
const refs1 = cs1 ? await refsOf(cs1.id) : [];
ev.note(`round 1 source refs: ${JSON.stringify(refs1)}`);

await ui.openItem('Approve the output of build?', 'For me');
noRecordingFor(ev, 'Inbox card', await page.text('body'));
await page.screenshot(ev.shot('first-review-card'));
await c.decideInInbox('Approve the output of build?', { filter: 'For me', option: 'Request changes', note: 'Escape the visitor name', confirm: false });
const decided = await until(async () => { const a = (await api.get(`/v1/approvals/${card.id}`)).approval; return a.status !== 'PENDING' && a; }, { label: 'card decided', timeoutMs: 15_000 });
ev.check('the build card is decided Request changes', decided.selectedOptionId === 'request_changes', { status: decided.status, option: decided.selectedOptionId });

const second = await until(async () => (await c.approvals(missionId, 'PENDING')).find((a) => a.taskId === build.id && a.id !== card.id), { label: 'second build review card', timeoutMs: 120_000 }).catch(() => null);
const build2 = await c.task(missionId, 'build');
ev.check('same build task, now round 2, back in review', build2.id === build.id && build2.round === 2 && build2.status === 'AWAITING_APPROVAL', { round: build2.round, status: build2.status });
ev.check('a new build review card appears (the review pipeline reran)', Boolean(second), second?.title);
const sets = changeSets();
const cs2 = sets.find((a) => a.round === 2);
const refs2 = cs2 ? await refsOf(cs2.id) : [];
const ref = (refs, kind) => refs.find((r) => r.kind === kind)?.value ?? null;
ev.note(`round 2 source refs: ${JSON.stringify(refs2)}`);
ev.check('the round-2 ChangeSet is on the same branch as round 1', Boolean(cs2) && ref(refs1, 'git.branch') !== null && ref(refs1, 'git.branch') === ref(refs2, 'git.branch'), { r1: ref(refs1, 'git.branch'), r2: ref(refs2, 'git.branch') });
ev.check('with a different commit', ref(refs1, 'git.commit') !== null && ref(refs2, 'git.commit') !== null && ref(refs1, 'git.commit') !== ref(refs2, 'git.commit'), { r1: ref(refs1, 'git.commit'), r2: ref(refs2, 'git.commit') });
const branch = ref(refs2, 'git.branch');
let log = '';
try { log = execFileSync('git', ['-C', env.project, 'log', branch, '--oneline', '--', 'hello.txt']).toString(); } catch (e) { log = `git failed: ${e.message}`; }
const hello = (() => { try { return execFileSync('git', ['-C', env.project, 'show', `${branch}:hello.txt`]).toString(); } catch { return ''; } })();
ev.check('the branch has a second commit touching hello.txt, from the round', log.trim().split('\n').filter(Boolean).length >= 2 && /round fb_/.test(hello), { log, hello });
const thread = await c.feedback(build.id);
ev.check('the note is addressed in round 2', thread.items[0]?.status === 'addressed' && thread.items[0].round === 2, thread.items);

await ui.openItem('Approve the output of build?', 'For me');
const inbox = await page.text('main');
ev.check('the Inbox shows the second review card with the three options', /Request changes/.test(inbox) && /Reject without changes/.test(inbox));
await page.screenshot(ev.shot('second-review-card'));
await page.navigate(`#/missions/${missionId}`); await sleep(1800);
const feedCard = await c.cardText('build');
ev.check('the feed card shows Round 2 in review with What changed', /Round 2/.test(feedCard) && /In review/.test(feedCard) && /What changed/i.test(feedCard), feedCard);
await page.screenshot(ev.shot('feed-round-2'));
await cancel(c, missionId, 'C11');
await resetStaffing(c);
c.close(); ev.save();
