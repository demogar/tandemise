// R5 — The relay's test clock moves 25 h and nothing else is touched. B now sees Take over, takes acme/app#11, and
// A's mission shows the Unclaimed banner "Bruno took over acme/app#11." with Stop, Take it back and Keep going
// without a claim. A's mission is still running. "Keep going without a claim" hides the banner.
import { Evidence } from '../../p0/lib/evidence.mjs';
import { readState, relayCall, sleep, until, windowFor } from '../common.mjs';

const A = process.env.ACCEPTANCE_SCRATCH;
const a = await windowFor(A, Number(process.env.CDP_PORT));
const b = await windowFor(process.env.ACCEPTANCE_SCRATCH_B, Number(process.env.CDP_PORT_B));
const ev = new Evidence('R5', 'A stale claim is taken over; the holder sees Unclaimed and keeps working');
const { ma, mb } = readState(A).r04;

const moved = await relayCall(A, 'POST', '/relay/v1/test/advance-clock', { ms: 25 * 3_600_000 });
ev.note(`relay clock now ${moved?.now}`);
await b.approvePlan(mb);
const dialog = await until(() => b.dialogText('Someone is working on this'), { label: 'refusal', timeoutMs: 10_000 });
const buttons = await b.dialogButtons('Someone is working on this');
ev.check('after 25 h away, B is offered Take over', buttons.includes('Take over'), { dialog, buttons });
await b.page.screenshot(ev.shot('b-take-over'));
await b.clickInDialog('Someone is working on this', 'Take over');
await until(async () => (await b.status(mb)) === 'EXECUTING', { label: "B's mission starts", timeoutMs: 20_000 });
ev.check("B's mission starts once B holds the item", (await b.status(mb)) === 'EXECUTING');

await a.page.navigate(`#/missions/${ma}`);
const banner = await until(async () => { const t = await a.claimBanner(); return (await a.claimBannerState()) === 'unclaimed' && t; }, { label: 'Unclaimed banner', timeoutMs: 15_000 }).catch(() => '');
ev.check('A\'s mission shows Unclaimed: "Bruno took over acme/app#11."', banner.includes('Bruno took over acme/app#11.'), banner);
const bannerButtons = await a.page.evaluate(`[...document.querySelectorAll('[data-claim] button')].map((x) => x.innerText.trim())`);
ev.check('…with Stop, Take it back and Keep going without a claim', ['Stop', 'Take it back', 'Keep going without a claim'].every((x) => bannerButtons.includes(x)), bannerButtons);
ev.check("…and A's mission is still running", (await a.status(ma)) === 'EXECUTING', await a.status(ma));
await a.page.screenshot(ev.shot('a-unclaimed'));
await a.page.click('Keep going without a claim');
const gone = await until(async () => (await a.claimBannerState()) === '', { label: 'banner gone', timeoutMs: 10_000 }).catch(() => false);
ev.check('Keep going without a claim hides the banner', gone === true);
ev.check('…and the mission is untouched', (await a.status(ma)) === 'EXECUTING');
await sleep(300);
await a.page.screenshot(ev.shot('a-kept-going'));

ev.save();
process.exit(ev.ok ? 0 : 1);
