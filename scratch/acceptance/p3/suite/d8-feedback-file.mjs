// D8 — Feedback with a file. On D2's mission (the design handed back in D4, then built and reviewed), Request
// changes on the review card with a note and an attached file, in the window. The file is pinned as Evidence
// and referenced from the note, and the review's next round reads it: it is among that run's inputs and in
// the prompt the agent was given.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { card, clickOnCard, docsSize, openFeed, readState, waitTask } from '../common.mjs';

const c = await context();
const { page, api, until } = c;
await docsSize(c);
const ev = new Evidence('D8', 'A file attached to feedback is an input of the next round');
const { d2 } = readState();
if (!d2?.missionId) throw new Error('D8 needs D2 first');
const { missionId, goal } = d2;

const review = await waitTask(c, missionId, 'review', (t) => t.status === 'SUCCEEDED', 'review finished', 180_000);
const roundBefore = review.round ?? 1;
const notes = '# Colours to use\n\nBackground #fffaf3, greeting #f6c28b, text #3b2f2a.\n';

await openFeed(c, missionId);
await clickOnCard(c, 'review', 'Request changes');
await until(async () => (await c.dialogText('Request changes to')).includes('What should change?'), { label: 'composer', timeoutMs: 10_000 });
await page.fill('What should change?', 'Check the page against the colours in the attached file.');
await page.attachFile('[role=dialog] .contrib > input[type=file]:nth-of-type(1)', { name: 'hello-colours.md', type: 'text/markdown', text: notes });
const composer = await c.dialogText('Request changes to');
ev.check('the composer shows the attached file', composer.includes('hello-colours.md'), composer);
await page.screenshot(ev.shot('composer-with-file'));
const sent = await page.evaluate(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].filter((x) => (x.getAttribute('aria-label') ?? '').startsWith('Request changes to')).pop(); const b = d && [...d.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Request changes' && !x.disabled); if (!b) return false; b.click(); return true; })()`);
ev.check('sent from the composer', sent);

// The API's feedback view carries no attachments; the row itself is read for proof.
const feedback = await until(() => c.sql("SELECT id, text, attachments FROM feedback WHERE task_id = ? AND attachments != '[]'", review.id).map((f) => ({ ...f, attachments: JSON.parse(f.attachments) }))[0], { label: 'feedback with attachment', timeoutMs: 30_000 }).catch(() => null);
const attached = feedback?.attachments?.find((a) => a.kind === 'artifact');
ev.check('proof (DB): the note references the file as an artifact, not its bytes', attached?.artifactId !== undefined && !JSON.stringify(feedback).includes('dataBase64'), feedback);
const pinned = attached ? (await api.get(`/v1/artifacts/${attached.artifactId}`)) : null;
ev.check('proof (API): the file is pinned as Evidence with its content', pinned?.manifest.type === 'Evidence' && pinned.body === notes && pinned.manifest.sourceRefs.some((r) => r.kind === 'file' && r.label === 'hello-colours.md'), pinned && { type: pinned.manifest.type, refs: pinned.manifest.sourceRefs, body: pinned.body });

const next = await waitTask(c, missionId, 'review', (t) => t.round === roundBefore + 1 && ['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(t.status), 'the next round finished', 120_000);
ev.check(`the review's round ${roundBefore + 1} ran and finished`, next.status === 'SUCCEEDED', { round: next.round, status: next.status, statusReason: next.statusReason });
const run = c.runs(next.id).filter((r) => r.round === next.round).at(-1);
const inputs = run ? c.sql('SELECT artifact_id AS id FROM run_inputs WHERE run_id = ?', run.id).map((r) => r.id) : [];
ev.check('the file is among the inputs of that round\'s run', attached !== undefined && inputs.includes(attached.artifactId), { run: run && { id: run.id, round: run.round }, inputs, file: attached?.artifactId });
const prompt = c.prompts().filter((p) => p.includes(goal) && p.includes('### ReviewReport') && p.includes('Check the page against the colours')).pop() ?? '';
ev.check('the round\'s prompt gives the agent the file', prompt.includes('hello-colours.md') || prompt.includes('#f6c28b'), (() => { const at = prompt.indexOf('hello-colours.md'); return at < 0 ? prompt.slice(0, 300) : prompt.slice(Math.max(0, at - 300), at + 300); })());

await openFeed(c, missionId);
const text = await until(async () => { const t = await card(c, 'review'); return t.includes(`Round ${roundBefore + 1}`) && t; }, { label: 'round card', timeoutMs: 20_000 }).catch(() => card(c, 'review'));
ev.check(`the review card shows Round ${roundBefore + 1}, answering the note`, text.includes(`Round ${roundBefore + 1}`) && text.includes('Check the page against the colours'), text);
await page.evaluate(`document.querySelector('[data-feed-card="review"]')?.scrollIntoView({ block: 'center' })`);
await page.screenshot(ev.shot('review-next-round'));
await page.navigate(`#/missions/${missionId}/artifacts`);
const artifacts = await until(async () => { const t = await page.text('main'); return t.includes('hello-colours.md') && t; }, { label: 'artifacts tab', timeoutMs: 15_000 }).catch(() => page.text('main'));
ev.check('the mission\'s Artifacts tab lists the attached file', artifacts.includes('hello-colours.md'), artifacts.slice(0, 600));
await page.screenshot(ev.shot('artifacts-tab'));

c.close(); ev.save();
