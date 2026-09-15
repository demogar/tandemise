// C3 — Review → Request changes: the Inbox review card starts round 2 of the same task, with no revision clone.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { assertSolo, noRecordingFor, resetStaffing, waitTask, cancel } from '../common.mjs';

const c = await context();
const { page, api, ui, sleep, until } = c;
const ev = new Evidence('C3', 'Review → Request changes: same task, round 2, no revision task');
await assertSolo(c, ev);
await resetStaffing(c);
await c.staff({ product: { assignees: [], reviews: [{ by: 'responsible', mode: 'blocking', when: 'always' }] } });

const title = `C3 review ${Date.now().toString(36)}`;
const missionId = await c.createMission(title, { workflow: 'P2 solo' });
ev.note(`mission ${missionId}`);
await c.approvePlan(missionId, title);
const doc = await waitTask(c, missionId, 'doc', (t) => t.status === 'AWAITING_APPROVAL', 'doc in review', 60_000);
const [card] = (await c.approvals(missionId, 'PENDING')).filter((a) => a.taskId === doc.id);
ev.check('a review card is open on doc for you', card && JSON.stringify(card.addressees) === JSON.stringify([c.me]), card?.addressees);
ev.check('the card offers Approve, Request changes, Reject without changes', JSON.stringify(card?.options.map((o) => o.label)) === JSON.stringify(['Approve', 'Request changes', 'Reject without changes']), card?.options.map((o) => o.label));

await ui.openItem('Approve the output of doc?', 'For me');
const opened = await page.text('main');
ev.check('the Inbox card shows the three options', /Approve/.test(opened) && /Request changes/.test(opened) && /Reject without changes/.test(opened), opened.slice(0, 800));
noRecordingFor(ev, 'Inbox card', await page.text('body'));
await page.screenshot(ev.shot('inbox-three-options'));
await c.decideInInbox('Approve the output of doc?', { filter: 'For me', option: 'Request changes', note: 'Name the page title in the first sentence.', confirm: false });

const decided = await until(async () => { const a = (await api.get(`/v1/approvals/${card.id}`)).approval; return a.status !== 'PENDING' && a; }, { label: 'card decided', timeoutMs: 15_000 });
ev.check('the card is decided as Request changes (REJECTED, request_changes), by you, with the note', decided.status === 'REJECTED' && decided.selectedOptionId === 'request_changes' && decided.decidedBy === c.me && /Name the page title/.test(decided.decisionNote ?? ''), { status: decided.status, option: decided.selectedOptionId, note: decided.decisionNote });
const second = await until(async () => (await c.approvals(missionId, 'PENDING')).find((a) => a.taskId === doc.id && a.id !== card.id), { label: 'round 2 review card', timeoutMs: 90_000 }).catch(() => null);
const round2 = await c.task(missionId, 'doc');
ev.check('same task id, now in round 2', round2.id === doc.id && round2.round === 2, { id: round2.id, round: round2.round, status: round2.status });
const keys = (await api.get(`/v1/missions/${missionId}/tasks`)).map((t) => t.key);
ev.check('the plan has no _revision_ task', keys.length === 1 && !keys.some((k) => k.includes('_revision_')), keys);
ev.check('a second review card opens for round 2', Boolean(second), second?.title);
const thread = await c.feedback(doc.id);
ev.check('the note is on the thread, addressed in round 2', thread.items.length === 1 && thread.items[0].round === 2 && ['addressed'].includes(thread.items[0].status), thread.items.map((i) => ({ status: i.status, round: i.round, text: i.text })));

await page.navigate(`#/missions/${missionId}`); await sleep(1800);
const feedCard = await c.cardText('doc');
ev.check('the feed card is back In review as Round 2 with What changed', /In review/.test(feedCard) && /Round 2/.test(feedCard) && /What changed/i.test(feedCard), feedCard);
await page.screenshot(ev.shot('round-2-in-review'));
const history = await ui.inbox('For me');
await page.screenshot(ev.shot('inbox-after'));
void history;
await cancel(c, missionId, 'C3');
await resetStaffing(c);
c.close(); ev.save();
