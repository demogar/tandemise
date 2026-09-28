// D7 — Attribution. D5's hand-back was yours: its card reads "by You", with the responsible person left out
// because they did the work (as on every card), and its reader says the same; the record holds you as both
// author and recorder. The reader shows "recorded by" once they differ, which in a solo project never
// happens, so the second half adds a teammate (through the daemon: the window has no "Add person" since
// 0.4.0) and hands back D5's build recording it for them: the card and the reader then read
// "by Dana Reyes · … · recorded by You". The teammate is removed again at the end.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { DIALOG_FILE, card, clickInDialog, continueElsewhere, docsSize, openFeed, openHandBack, readState, waitTask } from '../common.mjs';

const c = await context();
const { page, api, until } = c;
await docsSize(c);
const ev = new Evidence('D7', 'A hand-back is by you; the reader shows who recorded it');
const { d5 } = readState();
if (!d5?.missionId) throw new Error('D7 needs D5 first');
const { missionId } = d5;
const byline = (sel) => page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.innerText.trim().replace(/\\s+/g, ' ') ?? ''`);
const readerByline = () => page.evaluate(`[...document.querySelectorAll('[role=dialog]')].pop()?.querySelector('.reader__byline .attribution')?.innerText.trim().replace(/\\s+/g, ' ') ?? ''`);
const openReader = async (key) => {
  await page.evaluate(`[...document.querySelectorAll('[data-feed-card="${key}"] button')].find((x) => x.innerText.trim() === 'Full doc')?.click()`);
  return until(async () => (await readerByline()) || false, { label: `${key} reader`, timeoutMs: 10_000 }).catch(() => '');
};
const closeReader = () => page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

// ------------------------------------------------------------ yours
const detail = await api.get(`/v1/missions/${missionId}`);
const design = detail.tasks.find((t) => t.key === 'design');
const brief = detail.artifacts.find((a) => a.type === 'DesignBrief' && a.taskId === design.id && a.round === 2);
const pinned = detail.artifacts.find((a) => a.type === 'Evidence' && a.taskId === design.id);
ev.check('proof (API): the handed-back DesignBrief is authored and recorded by you', brief?.authorId === c.me && brief?.recordedBy === c.me, brief && { authorId: brief.authorId, recordedBy: brief.recordedBy, responsibleId: brief.responsibleId, me: c.me });
ev.check('proof (API): so is its Evidence', pinned?.authorId === c.me && pinned?.recordedBy === c.me, pinned && { authorId: pinned.authorId, recordedBy: pinned.recordedBy });

await openFeed(c, missionId);
const mine = await byline('[data-feed-card="design"] .feedcard__byline .attribution');
ev.check('the hand-back card reads "by You", with no "responsible" and no "recorded by"', mine === 'by You', mine);
await page.evaluate(`document.querySelector('[data-feed-card="design"]')?.scrollIntoView({ block: 'center' })`);
await page.screenshot(ev.shot('card-by-you'));
const mineReader = await openReader('design');
ev.check('its reader reads "by You": you did it and recorded it, so the recorder is not repeated', mineReader === 'by You', mineReader);
await page.screenshot(ev.shot('reader-by-you'));
await closeReader();
await c.sleep(400);

// ------------------------------------------------------------ recorded for someone else
const person = await api.post('/v1/people', { displayName: 'Dana Reyes' });
const member = await api.post(`/v1/workspaces/${c.env.workspaceId}/members`, { kind: 'person', personId: person.id ?? person.person?.id, reportsTo: c.me });
const dana = member.id;
ev.note(`added Dana Reyes (member ${dana}) through the daemon, for this half only`);
try {
  await page.send('Page.reload', {});
  await c.sleep(2500);
  await docsSize(c);
  await continueElsewhere(c, missionId, 'build', undefined);
  await openHandBack(c, missionId, 'build', 'Dana finished the page in her editor; recorded here for her.');
  await page.attachFile(DIALOG_FILE, { name: 'hello-page.patch', type: 'text/x-diff', text: '--- a/hello.html\n+++ b/hello.html\n@@ -0,0 +1 @@\n+<h1>Hello, Dana</h1>\n' });
  await page.select('Recording for', 'Dana Reyes');
  await page.screenshot(ev.shot('hand-back-recording-for'));
  await clickInDialog(c, 'Hand back');
  const back = await waitTask(c, missionId, 'build', (t) => t.parkedExternal === null && t.round === 2, 'build handed back for Dana', 60_000);
  const changeSet = (await api.get(`/v1/missions/${missionId}`)).artifacts.find((a) => a.type === 'ChangeSet' && a.taskId === back.id && a.round === 2);
  ev.check('proof (API): the ChangeSet is authored by Dana and recorded by you', changeSet?.authorId === dana && changeSet?.recordedBy === c.me, changeSet && { authorId: changeSet.authorId, recordedBy: changeSet.recordedBy, responsibleId: changeSet.responsibleId, dana, me: c.me });
  await openFeed(c, missionId);
  const theirs = await until(async () => { const t = await byline('[data-feed-card="build"] .feedcard__byline .attribution'); return t.includes('Dana') && t; }, { label: 'build byline', timeoutMs: 20_000 }).catch(() => byline('[data-feed-card="build"] .feedcard__byline .attribution'));
  ev.check('the card reads "by Dana Reyes … recorded by You"', theirs.startsWith('by Dana Reyes') && theirs.endsWith('recorded by You'), theirs);
  await page.evaluate(`document.querySelector('[data-feed-card="build"]')?.scrollIntoView({ block: 'center' })`);
  await page.screenshot(ev.shot('card-by-dana'));
  const theirsReader = await openReader('build');
  ev.check('the reader shows "recorded by You"', theirsReader.startsWith('by Dana Reyes') && theirsReader.includes('recorded by You'), theirsReader);
  await page.screenshot(ev.shot('reader-recorded-by'));
  await closeReader();
  ev.note(`build card: ${await card(c, 'build')}`);
} finally {
  await api.del(`/v1/members/${dana}`).catch((e) => ev.note(`could not remove Dana: ${e.message}`));
  await page.send('Page.reload', {});
  await c.sleep(2000);
}

c.close(); ev.save();
