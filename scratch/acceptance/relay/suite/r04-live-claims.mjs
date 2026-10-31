// R4 — A starts a mission on acme/app#11; B's Home "Who's working on what" shows Ana on it within 2 s. B starting
// the same item is refused: "Ana is working on acme/app#11 since …", with Not now and no Take over (B is a member
// and Ana is around).
import { Evidence } from '../../p0/lib/evidence.mjs';
import { until, windowFor, writeState } from '../common.mjs';

const a = await windowFor(process.env.ACCEPTANCE_SCRATCH, Number(process.env.CDP_PORT));
const b = await windowFor(process.env.ACCEPTANCE_SCRATCH_B, Number(process.env.CDP_PORT_B));
const ev = new Evidence('R4', "A's claim shows in B live, and B is refused the same item");

await b.openHome();
const ma = await a.createMission('Add offline mode (relay r04, Ana)');
a.linkIssue(ma, 11, 'Offline mode for the hello page');
await a.approvePlan(ma);
await until(async () => (await a.status(ma)) === 'EXECUTING', { label: 'A running', timeoutMs: 20_000 });
const t0 = Date.now();
const row = await until(async () => { const t = await b.whoText(); return t.includes('acme/app#11') && t; }, { label: "Ana's row in B", timeoutMs: 2_000, everyMs: 100 }).catch(() => '');
ev.check("B's Home shows Ana on acme/app#11 within 2 s", row.includes('Ana') && row.includes('acme/app#11'), { row, ms: Date.now() - t0 });
await b.page.screenshot(ev.shot('b-home'));

const mb = await b.createMission('Add offline mode too (relay r04, Bruno)');
b.linkIssue(mb, 11, 'Offline mode for the hello page');
await b.approvePlan(mb);
const dialog = await until(() => b.dialogText('Someone is working on this'), { label: 'refusal', timeoutMs: 10_000 });
ev.check('B is refused: "Ana is working on acme/app#11 since …"', /Ana is working on acme\/app#11 since \d\d:\d\d\./.test(dialog), dialog);
const buttons = await b.dialogButtons('Someone is working on this');
ev.check('…with Not now and no Take over', buttons.includes('Not now') && !buttons.includes('Take over'), buttons);
await b.page.screenshot(ev.shot('b-refused'));
await b.clickInDialog('Someone is working on this', 'Not now');
ev.check("B's mission did not start", (await b.status(mb)) === 'AWAITING_PLAN_APPROVAL', await b.status(mb));

writeState(process.env.ACCEPTANCE_SCRATCH, { r04: { ma, mb } });
ev.save();
process.exit(ev.ok ? 0 : 1);
