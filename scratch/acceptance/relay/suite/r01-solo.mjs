// R1 — Solo, no relay: a mission on GitHub issue acme/app#7 claims it when its plan is approved, Home's
// "Who's working on what" shows it as yours, a second mission on the same issue is refused in plain words
// with no Take over, and finishing the first mission clears the row.
import { Evidence } from '../../p0/lib/evidence.mjs';
import { DEVICE_LABEL, sleep, until, windowFor } from '../common.mjs';

const a = await windowFor(process.env.ACCEPTANCE_SCRATCH, Number(process.env.CDP_PORT));
const ev = new Evidence('R1', 'Solo: who is working on what, and a held item is refused');
const { page } = a;

const m1 = await a.createMission('Fix the hello page header (relay r01 first)');
a.linkIssue(m1, 7, 'Fix the hello page header');
await a.approvePlan(m1);
await until(async () => (await a.status(m1)) === 'EXECUTING', { label: 'first mission running', timeoutMs: 20_000 });
ev.check('approving the plan starts the issue-linked mission', (await a.status(m1)) === 'EXECUTING');

await a.openHome();
const row = await until(async () => { const t = await a.whoText(); return t.includes('acme/app#7') && t; }, { label: 'claim row', timeoutMs: 10_000 });
ev.check('Home: "Who\'s working on what" has a row for acme/app#7', row.includes('acme/app#7'), row);
ev.check('…and it is yours', row.includes('You'), row);
await page.screenshot(ev.shot('home-row'));

const m2 = await a.createMission('Fix the hello page header again (relay r01 second)');
a.linkIssue(m2, 7);
await a.approvePlan(m2);
const dialog = await until(() => a.dialogText('Someone is working on this'), { label: 'refusal dialog', timeoutMs: 10_000 });
ev.check('a second mission on the same issue is refused in a dialog', dialog.length > 0, dialog);
ev.check(`…in plain words: "You're already working on this on ${DEVICE_LABEL}."`, dialog.includes(`You're already working on this on ${DEVICE_LABEL}.`), dialog);
const buttons = await a.dialogButtons('Someone is working on this');
ev.check('…with Not now and no Take over (it is yours)', buttons.includes('Not now') && !buttons.includes('Take over'), buttons);
await page.screenshot(ev.shot('refused'));
ev.check('the second mission did not start; its plan still waits', (await a.status(m2)) === 'AWAITING_PLAN_APPROVAL', await a.status(m2));
await a.clickInDialog('Someone is working on this', 'Not now');

await a.finishStep(m1);
await a.openHome();
const gone = await until(async () => !(await a.whoText()).includes('acme/app#7'), { label: 'row gone', timeoutMs: 2_000 }).catch(() => false);
ev.check('finishing the first mission clears its row within 2 s', gone === true, await a.whoText());
const empty = await a.whoText();
ev.check('…and Home says nobody is working on a tracker item', empty.includes('Nobody is working on a tracker item right now.'), empty);
await sleep(300);
await page.screenshot(ev.shot('home-empty'));

ev.save();
process.exit(ev.ok ? 0 : 1);
