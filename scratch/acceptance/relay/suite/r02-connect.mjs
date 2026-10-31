// R2 — Window A, solo, is working on acme/app#7. Settings → Team relay goes from "local" to "connected" with the
// relay's address and its bootstrap admin code, and "Bring my local data" brings that claim up to the relay.
import { Evidence } from '../../p0/lib/evidence.mjs';
import { connectWindow, relayCall, relayInfo, relaySettings, relayState, relayText, sleep, until, windowFor } from '../common.mjs';

const A = process.env.ACCEPTANCE_SCRATCH;
const a = await windowFor(A, Number(process.env.CDP_PORT));
const ev = new Evidence('R2', 'Connect window A to the relay and bring its local data');
const relay = relayInfo(A);

const m = await a.createMission('Ship the hello page header (relay r02)');
a.linkIssue(m, 7, 'Fix the hello page header');
await a.approvePlan(m);
await until(async () => (await a.status(m)) === 'EXECUTING', { label: 'running', timeoutMs: 20_000 });

await relaySettings(a);
ev.check('Settings → Team relay starts local', (await relayState(a)) === 'local', await relayState(a));
const localText = await relayText(a);
ev.check('…"Only this computer knows what you\'re working on."', localText.includes("Only this computer knows what you're working on."), localText);
await a.page.screenshot(ev.shot('local'));
const connected = await connectWindow(a, { url: relay.url, code: relay.invite, name: 'Ana', device: 'Ana laptop' });
ev.check('after the address and the code it is connected', connected === true && (await relayState(a)) === 'connected', await relayText(a));
const text = await relayText(a);
ev.check(`…"Connected to ${new URL(relay.url).host}" with the team name`, text.includes(`Connected to ${new URL(relay.url).host}`) && text.includes('Acceptance team'), text);
ev.check('…offering "Bring my local data"', text.includes('Bring my local data'), text);
await a.page.screenshot(ev.shot('connected'));
await a.page.click('Bring my local data', { within: 'section[aria-label="Team relay"]' });
await until(async () => !(await relayText(a)).includes('Bring my local data'), { label: 'import done', timeoutMs: 15_000 });
await sleep(500);
const snap = await relayCall(A, 'GET', '/relay/v1/snapshot');
ev.check('the relay now holds acme/app#7 for Ana', (snap?.claims ?? []).some((c) => c.itemRef === 'github:acme/app#7' && c.memberName === 'Ana'), snap?.claims);
await a.openHome();
const row = await until(async () => { const t = await a.whoText(); return t.includes('acme/app#7') && t; }, { label: 'row', timeoutMs: 10_000 }).catch(() => '');
ev.check('Home still says you are on acme/app#7, now through the relay', row.includes('You') && !row.includes('Pending'), row);
await a.finishStep(m);

ev.save();
process.exit(ev.ok ? 0 : 1);
