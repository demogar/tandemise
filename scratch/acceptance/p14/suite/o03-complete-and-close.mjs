// O3 — Turn on "Close the issue when the mission completes"; plan #11's draft from its header, approve the plan in
// the Inbox, let it complete. The fake gh recorded one completion comment with the criteria table (U1–U3 Verified)
// and one `gh issue close 11`; the timeline says so.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { ghCalls, issueComments, issueState, openIssues, readScenarioState, setSwitch, settle, timelineText } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('O3', 'The mission completes: the issue gets the criteria table and is closed');
const { id } = readScenarioState().o1;

await openIssues(c);
await setSwitch(c, 'Close the issue when the mission completes', true);
const settings = (await c.api.get(`/v1/workspaces/${c.env.workspaceId}/issues`)).repositories[0].settings;
ev.check('proof (API): close on completion is on', settings.closeOnComplete === true, settings);

await c.missionAction(id, 'Plan');
const title = (await c.api.get(`/v1/missions/${id}`)).mission.title;
await c.approvePlan(id, title);
const status = await settle(c, id);
ev.check('the mission completes', status === 'COMPLETE', status);

const done = await until(() => issueComments(11).find((x) => x.body.includes('tandemise:completed')), { label: 'completion comment', timeoutMs: 30_000 });
ev.check('one completion comment: "Done in Tandemise — N of N criteria verified."', /Done in Tandemise — (\d+) of \1 criteria verified\./.test(done.body), done.body);
ev.check('the table lists U1–U3 as Verified', ['U1', 'U2', 'U3'].every((k) => new RegExp(`\\| ${k} \\| [^|]+ \\| Verified \\|`).test(done.body)), done.body);
ev.check('and says it is closing the issue', done.body.includes('Closing this issue: every criterion was verified.'), done.body);
await until(() => issueState(11) === 'CLOSED', { label: 'issue closed', timeoutMs: 20_000 });
const closes = ghCalls().filter((x) => x.args[0] === 'issue' && x.args[1] === 'close');
ev.check('proof (fake gh): exactly one `gh issue close 11 --repo example/hello-site`', closes.length === 1 && closes[0].args.includes('11') && closes[0].args.includes('example/hello-site'), closes);
ev.check('proof (fake gh): two comments on #11 in all (queued, completed)', issueComments(11).length === 2, issueComments(11).map((x) => x.body.split('\n')[0]));

const timeline = await timelineText(c, id);
ev.check('timeline: "Closed GitHub issue #11: every criterion was verified."', timeline.includes('Closed GitHub issue #11: every criterion was verified.'), timeline.slice(0, 1500));
await page.screenshot(ev.shot('timeline-closed'));
await sleep(6000);
ev.check('nothing more is written on later passes', ghCalls().filter((x) => x.args[0] === 'issue' && x.args[1] === 'close').length === 1 && issueComments(11).length === 2);
c.close(); ev.save();
