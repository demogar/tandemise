// O4 — Check now again: no new mission. Then a new labelled issue #13 with criteria is checked in (queued), is
// closed upstream, and Check now takes its draft off the queue ("Not queued") with a timeline note.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { backlogRows, checkNow, editIssue, fileIssue, ghCalls, missionCount, missionForIssue, openBacklog, openIssues, timelineText } from '../common.mjs';

const c = await context();
const { page, until } = c;
const ev = new Evidence('O4', 'A repeat check creates nothing; an issue closed upstream takes its draft off the queue');

const missions = await missionCount(c);
const lists = ghCalls().filter((x) => x.args[1] === 'list').length;
await openIssues(c);
await checkNow(c, (t) => t.endsWith('· 2 linked'), '2 linked');
ev.check('a repeat check read GitHub again', ghCalls().filter((x) => x.args[1] === 'list').length > lists);
ev.check('…and created no mission', (await missionCount(c)) === missions, { before: missions, after: await missionCount(c) });

fileIssue({ number: 13, title: 'Add a dark theme', author: 'sam', body: '### Acceptance criteria\n- [ ] Colours follow the system setting\n' });
const three = await checkNow(c, (t) => t.endsWith('· 3 linked'), '3 linked');
ev.check('#13 checked in: "… · 3 linked"', three === 'Last checked just now · 3 linked', three);
await openBacklog(c);
const queued = await until(async () => (await backlogRows(c)).find((r) => r.title === 'Add a dark theme'), { label: '#13 row', timeoutMs: 20_000 });
ev.check('#13 is queued', queued.queue.startsWith('Queued'), queued);

editIssue(13, { state: 'CLOSED' });
await openIssues(c);
await checkNow(c, (t) => t.startsWith('Last checked'), 'checked after close');
await openBacklog(c);
const row = await until(async () => { const r = (await backlogRows(c)).find((x) => x.title === 'Add a dark theme'); return r && r.queue === 'Not queued' && r; }, { label: '#13 not queued', timeoutMs: 20_000 });
ev.check('closed upstream: its draft reads "Not queued"', row.queue === 'Not queued', row);
await page.screenshot(ev.shot('dequeued'));
const id = await missionForIssue(c, 13);
const timeline = await timelineText(c, id);
ev.check('timeline: "Issue #13 was closed upstream, so this draft was taken off the queue."', timeline.includes('Issue #13 was closed upstream, so this draft was taken off the queue.'), timeline.slice(0, 1500));
await page.screenshot(ev.shot('timeline-closed-upstream'));
const mission = (await c.api.get(`/v1/missions/${id}`)).mission;
ev.check('proof (API): still a DRAFT (not deleted), queuedAt cleared', mission.status === 'DRAFT' && mission.queuedAt === null, mission);
ev.check('proof (API): the link says closed', (await c.api.get(`/v1/workspaces/${c.env.workspaceId}/issues`)).links.find((l) => l.number === 13)?.state === 'closed');
c.close(); ev.save();
