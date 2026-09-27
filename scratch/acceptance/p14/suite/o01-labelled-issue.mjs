// O1 — Turn issues on for the repository in Repositories → Issues (GitHub repository typed in, the "P10 desk"
// workflow), with a labelled issue #11 whose body has a "## Done when" checklist. Check now: the draft appears in
// the Backlog with an "#11" chip, Ready and Queued; its Done when lists U1–U3; its header reads "From issue #11";
// and the fake gh recorded the "Queued in Tandemise — 3 criteria" comment on #11.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { backlogRows, checkNow, docShot, fileIssue, ghCalls, issueComments, missionForIssue, openBacklog, openIssues, setSwitch, statusLine, writeScenarioState } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('O1', 'A labelled issue with a Done-when checklist becomes a queued, ready draft');

fileIssue({
  number: 11, title: 'Offline mode for the hello page', author: 'sam',
  body: 'Visitors on a train lose the page.\n\n## Done when\n- [ ] The page loads with no network\n- [ ] It says hello to the visitor\n- [ ] It shows when it was last updated\n',
});

const before = await openIssues(c);
ev.check('Repositories → Issues shows the repository, off', before.includes('acceptance-project') && (await statusLine(c)) === 'Off', before.slice(0, 500));
await page.fill('GitHub repository', 'example/hello-site');
await page.select('Workflow for issues', 'P10 desk');
await setSwitch(c, 'Turn labelled issues into missions', true);
const on = await until(async () => { const t = await statusLine(c); return t.includes('linked') && t; }, { label: 'status after switching on', timeoutMs: 20_000 });
ev.check('switched on: the status line counts linked issues', /· \d+ linked$/.test(on), on);
const checked = await checkNow(c, (t) => t.endsWith('· 1 linked'), '1 linked');
ev.check('Check now → "Last checked just now · 1 linked"', checked === 'Last checked just now · 1 linked', checked);
await page.screenshot(ev.shot('issues-settings'));
await page.evaluate(`(() => { const s = document.querySelector('section[aria-label="Issues"]'); s.scrollIntoView({ block: 'start' }); let p = s.parentElement; while (p && p.scrollHeight <= p.clientHeight) p = p.parentElement; if (p) p.scrollTop -= 110; })()`);
await docShot(c, 'github-issues-settings');

const settings = (await c.api.get(`/v1/workspaces/${c.env.workspaceId}/issues`)).repositories[0].settings;
ev.check('proof (API): on, example/hello-site, label tandemise, every 10 minutes, P10 desk', settings.enabled && settings.githubRepo === 'example/hello-site' && settings.label === 'tandemise' && settings.pollMinutes === 10 && settings.workflowPreset !== null, settings);

await openBacklog(c);
const row = await until(async () => (await backlogRows(c)).find((r) => r.title === 'Offline mode for the hello page'), { label: 'backlog row', timeoutMs: 20_000 });
const rowText = await page.evaluate(`[...document.querySelectorAll('section[aria-label="Backlog"] .list__row')].find((r) => r.innerText.includes('Offline mode for the hello page'))?.innerText ?? ''`);
ev.check('Backlog: the draft with an "#11" chip', rowText.includes('#11'), rowText);
ev.check('…Ready and Queued', row.readiness === 'Ready' && row.queue.startsWith('Queued'), row);
await page.screenshot(ev.shot('backlog'));
await docShot(c, 'github-issues-backlog');

const id = await missionForIssue(c, 11);
await page.navigate(`#/missions/${id}`);
await until(() => page.evaluate(`Boolean(document.querySelector('[aria-label="From issue #11"]'))`), { label: 'From issue #11', timeoutMs: 20_000 });
await sleep(800);
const header = await page.text('.topbar, header, main');
ev.check('mission header: "From issue #11"', header.includes('From issue #11'), header.slice(0, 400));
const doneWhen = await page.evaluate(`document.querySelector('[aria-label="Done when"]')?.innerText ?? ''`);
ev.check('Done when lists U1–U3 from the checklist', ['U1', 'The page loads with no network', 'U2', 'It says hello to the visitor', 'U3', 'It shows when it was last updated'].every((s) => doneWhen.includes(s)), doneWhen);
ev.check('each line says it came from the GitHub issue', (doneWhen.match(/From the GitHub issue/g) ?? []).length === 3 && !doneWhen.includes('Added by you'), doneWhen);
const body = await page.text('main');
ev.check('the goal names the issue and its author', body.includes('GitHub issue #11 in example/hello-site, opened by @sam'), body.slice(0, 600));
await page.screenshot(ev.shot('mission'));
await docShot(c, 'github-issues-mission');

const comments = await until(() => { const list = issueComments(11); return list.length > 0 && list; }, { label: 'queued comment', timeoutMs: 20_000 });
ev.check('proof (fake gh): one comment on #11, "Queued in Tandemise — 3 criteria."', comments.length === 1 && comments[0].body.includes('<!-- tandemise:queued -->') && comments[0].body.includes('Queued in Tandemise — 3 criteria.'), comments);
ev.check('proof (fake gh): read with --label tandemise --state open', ghCalls().some((x) => x.args[0] === 'issue' && x.args[1] === 'list' && x.args.includes('tandemise') && x.args.includes('open')), ghCalls().slice(0, 3));

writeScenarioState({ o1: { id } });
c.close(); ev.save();
