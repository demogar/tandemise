// O2 — A labelled issue #12 with no criteria. Check now: its draft is in the Backlog as "Needs refinement" and
// "Not queued", with an "#12" chip; nothing was posted on #12.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { backlogRows, checkNow, fileIssue, ghCalls, issueComments, missionForIssue, openBacklog, openIssues } from '../common.mjs';

const c = await context();
const { page, until } = c;
const ev = new Evidence('O2', 'A labelled issue without criteria waits as "Needs refinement"');

fileIssue({ number: 12, title: 'Make the footer friendlier', author: 'kim', body: 'The footer reads like a legal notice. Ideas welcome.' });
await openIssues(c);
const status = await checkNow(c, (t) => t.endsWith('· 2 linked'), '2 linked');
ev.check('Check now → "… · 2 linked"', status === 'Last checked just now · 2 linked', status);

await openBacklog(c);
const row = await until(async () => (await backlogRows(c)).find((r) => r.title === 'Make the footer friendlier'), { label: 'backlog row', timeoutMs: 20_000 });
const rowText = await page.evaluate(`[...document.querySelectorAll('section[aria-label="Backlog"] .list__row')].find((r) => r.innerText.includes('Make the footer friendlier'))?.innerText ?? ''`);
ev.check('Backlog: "#12", "Needs refinement", "Not queued"', rowText.includes('#12') && row.readiness === 'Needs refinement' && row.queue === 'Not queued', { row, rowText });
await page.screenshot(ev.shot('needs-refinement'));

const id = await missionForIssue(c, 12);
const mission = (await c.api.get(`/v1/missions/${id}`)).mission;
ev.check('proof (API): a DRAFT, not queued, no criteria', mission.status === 'DRAFT' && mission.queuedAt === null && (await c.api.get(`/v1/missions/${id}/criteria`)).filter((x) => x.status === 'accepted').length === 0, mission);
ev.check('proof (fake gh): nothing posted on #12', issueComments(12).length === 0 && !ghCalls().some((x) => x.args.some((a) => /issues\/12\/comments$/.test(a)) && x.args.includes('POST')));
c.close(); ev.save();
