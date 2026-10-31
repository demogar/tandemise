// H10 — Hold an output under review. Holding a step whose output waits for
// your review opens a new round; Continue produces a new version of the
// output, and it goes through review again.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { SCRIPTS, newMission, fakeProfile, holdFromDrawer, openFeed, panelButton, panelLabel, stepOf, typeLine, useRuntimes, waitScreen, waitStep, shoot } from '../common.mjs';

const c = await context();
const { page, api, until } = c;
const ev = new Evidence('H10', 'Hold an output under review: a new round, a new version, reviewed again');
await useRuntimes(c, [await fakeProfile(c, 'Hold fake quick', SCRIPTS.quick)]);

const missionId = await newMission(c, `Reviewed onboarding ${Date.now().toString(36)}`, 'Hold review');
const review = await waitStep(c, missionId, (t) => t.status === 'AWAITING_APPROVAL', 'the output under review', { timeoutMs: 90_000 });
const card = (await c.approvals(missionId, 'PENDING')).find((a) => a.taskId === review.id && a.kind !== 'check');
const briefsBefore = (await api.get(`/v1/missions/${missionId}/artifacts`)).filter((a) => a.taskId === review.id && a.type === 'DesignBrief');
ev.check('proof (API): its output waits for your review', card !== undefined && briefsBefore.length === 1 && review.holdable.ok === true, { card: card?.title, briefs: briefsBefore.length, holdable: review.holdable });
const roundBefore = review.round ?? 1;

await holdFromDrawer(c, missionId, review.title);
ev.check('Hold from its drawer opens the terminal panel', (await panelLabel(c)) === `Terminal: ${review.title}`);
const screen = await waitScreen(c, 'Fake session').catch(() => '');
ev.check('the step\'s last session is resumed', screen.includes('Fake session sess-quick-'), screen);
const held = await stepOf(c, missionId);
ev.check('proof (API): HELD, in a new round', held.status === 'HELD' && (held.round ?? 1) === roundBefore + 1, { status: held.status, round: held.round });
const decided = (await api.get(`/v1/approvals/${card.id}`)).approval;
ev.check('proof (API): the review card is no longer waiting', decided.status !== 'PENDING', decided.status);

await typeLine(c, 'write review-notes.txt');
await waitScreen(c, 'wrote review-notes.txt').catch(() => '');
await shoot(c, ev, 'held-for-changes');
await panelButton(c, 'Continue');
await until(async () => (await panelLabel(c)) === '', { label: 'panel closes', timeoutMs: 20_000 });

const again = await waitStep(c, missionId, (t) => t.status === 'AWAITING_APPROVAL' || t.status === 'FAILED', 'the new version under review', { timeoutMs: 90_000 });
const newCard = (await c.approvals(missionId, 'PENDING')).find((a) => a.taskId === again.id && a.kind !== 'check');
const briefs = (await api.get(`/v1/missions/${missionId}/artifacts`)).filter((a) => a.taskId === again.id && a.type === 'DesignBrief');
ev.check('Continue produces a new version of the output, replacing the reviewed one', briefs.some((b) => b.id !== briefsBefore[0].id && b.supersedes === briefsBefore[0].id), briefs.map((b) => ({ id: b.id, supersedes: b.supersedes })));
ev.check('which goes through review again: a new review card waits for you', again.status === 'AWAITING_APPROVAL' && newCard !== undefined && newCard.id !== card.id, { status: again.status, card: newCard?.title });

await openFeed(c, missionId);
const cardText = await c.cardText('design');
ev.check('its card reads Round 2, in review', /Round 2/.test(cardText) && /In review/.test(cardText), cardText.slice(0, 200));
await shoot(c, ev, 'round-2-review');
await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: H10 proven' });
await useRuntimes(c, [await fakeProfile(c, 'Hold fake', SCRIPTS.long)]);
c.close(); ev.save();
