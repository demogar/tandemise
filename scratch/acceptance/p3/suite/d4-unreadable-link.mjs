// D4 — Hand back a link nothing here can read (a Figma file), on the design D2 took to Figma. A bare link is
// refused in the dialog with "Nothing here can read that link. Attach an export of it." and nothing is
// written; the same link with an export attached is taken, and the export (not the link) becomes the Evidence.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { addLinkInDialog, card, clickInDialog, docsSize, openFeed, openHandBack, readState, refs, waitTask } from '../common.mjs';

const c = await context();
const { page, api, until } = c;
await docsSize(c);
const ev = new Evidence('D4', 'An unreadable link is refused until an export is attached');
const { d2 } = readState();
if (!d2?.missionId) throw new Error('D4 needs D2 first (the design parked in Figma)');
const { missionId } = d2;
const figma = 'https://www.figma.com/file/abc123/hello-page';
const artifactsBefore = (await api.get(`/v1/missions/${missionId}`)).artifacts.length;

await openHandBack(c, missionId, 'design', 'Moved the greeting up and made it larger, in Figma.');
await addLinkInDialog(c, figma);
await clickInDialog(c, 'Hand back');
const refused = await until(async () => { const t = await c.dialogText('Hand back '); return t.includes('Attach an export') && t; }, { label: 'refusal', timeoutMs: 30_000 }).catch(() => c.dialogText('Hand back '));
ev.check('a bare link is refused in the dialog: "Nothing here can read that link. Attach an export of it."', refused.includes('Nothing here can read that link. Attach an export of it.'), refused);
await page.screenshot(ev.shot('bare-link-refused'));
const still = await c.task(missionId, 'design');
const artifactsAfter = (await api.get(`/v1/missions/${missionId}`)).artifacts.length;
ev.check('proof (API): nothing was written; the design is still parked in Figma', still.parkedExternal?.tool === 'Figma' && still.round === 1 && artifactsAfter === artifactsBefore, { parked: still.parkedExternal, round: still.round, artifactsBefore, artifactsAfter });

// The same link, with an export of it.
await page.evaluate(`[...document.querySelectorAll('[role=dialog] .contrib__remove')].forEach((b) => b.click())`);
await c.sleep(300);
const exported = '# Hello page (Figma export)\n\nThe greeting sits higher on the page and is larger.\n';
await addLinkInDialog(c, figma, { name: 'hello-page-export.md', type: 'text/markdown', text: exported });
const chip = await page.evaluate(`[...document.querySelectorAll('[role=dialog] .contrib__chip')].map((x) => x.innerText.trim()).join(' | ')`);
ev.check('the dialog shows the link with its export', chip.includes(figma) && chip.includes('+ hello-page-export.md'), chip);
ev.check('the refusal cleared once the work changed', !(await c.dialogText('Hand back ')).includes('Nothing here can read that link'));
await page.screenshot(ev.shot('link-with-export'));
await clickInDialog(c, 'Hand back');
const back = await waitTask(c, missionId, 'design', (t) => t.parkedExternal === null && t.round === 2, 'handed back', 60_000);
ev.check('proof (API): the design is round 2, SUCCEEDED, "Handed back from Figma."', back.status === 'SUCCEEDED' && back.statusReason === 'Handed back from Figma.', { status: back.status, round: back.round, statusReason: back.statusReason });

const detail = await api.get(`/v1/missions/${missionId}`);
const evidence = detail.artifacts.filter((a) => a.type === 'Evidence' && a.taskId === back.id);
ev.check('exactly one Evidence was pinned: the refused attempt left none behind', evidence.length === 1, evidence.map((a) => ({ id: a.id, title: a.title, refs: refs(a) })));
const pinned = evidence[0];
ev.check('the Evidence is the export: its file ref names hello-page-export.md, beside the link\'s url', pinned !== undefined
  && refs(pinned).includes(`url=${figma}`) && pinned.sourceRefs.some((r) => r.kind === 'file' && r.label === 'hello-page-export.md'), pinned && refs(pinned));
const body = pinned ? (await api.get(`/v1/artifacts/${pinned.id}`)).body : '';
ev.check('the Evidence\'s content is the export\'s bytes', body === exported, body);
const brief = detail.artifacts.find((a) => a.type === 'DesignBrief' && a.taskId === back.id && a.round === 2);
const briefBody = brief ? (await api.get(`/v1/artifacts/${brief.id}`)).body : '';
ev.check('the round-2 DesignBrief carries the note and the export\'s text', briefBody.includes('Moved the greeting up') && briefBody.includes('The greeting sits higher on the page'), briefBody.slice(0, 400));

await openFeed(c, missionId);
const text = await until(async () => { const t = await card(c, 'design'); return t.includes('Round 2') && t; }, { label: 'round 2 card', timeoutMs: 20_000 }).catch(() => card(c, 'design'));
ev.check('the design card shows Round 2 with a link back to the Figma file ("Open the link ↗")', text.includes('Round 2') && text.includes('Open the link'), text);
const title = await page.evaluate(`[...document.querySelectorAll('[data-feed-card="design"] button')].find((b) => b.innerText.includes('Open the link'))?.title ?? ''`);
ev.check('that link is the Figma URL', title === figma, title);
await page.evaluate(`document.querySelector('[data-feed-card="design"]')?.scrollIntoView({ block: 'center' })`);
await page.screenshot(ev.shot('design-round-2-card'));

c.close(); ev.save();
