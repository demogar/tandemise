// R3 — The Team screen in window A: "Invite someone" shows a single-use code once. Window B joins with it, and
// B's Team screen lists Ana with an online dot.
import { Evidence } from '../../p0/lib/evidence.mjs';
import { connectWindow, relayInfo, sleep, until, windowFor } from '../common.mjs';

const CODE_RE = /^TRI-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{6}$/;
const A = process.env.ACCEPTANCE_SCRATCH;
const a = await windowFor(A, Number(process.env.CDP_PORT));
const b = await windowFor(process.env.ACCEPTANCE_SCRATCH_B, Number(process.env.CDP_PORT_B));
const ev = new Evidence('R3', 'Invite someone from the Team screen; window B joins');
const relay = relayInfo(A);

await a.page.navigate('#/team');
await until(() => a.page.evaluate(`Boolean(document.querySelector('section[aria-label="Team relay members"]'))`), { label: 'Team relay block', timeoutMs: 20_000 });
await a.page.click('Invite someone');
await a.page.fill('Their name', 'Bruno');
await a.page.click('Make an invite code');
const code = await until(() => a.page.evaluate(`document.querySelector('[data-invite-code]')?.innerText.trim() ?? ''`), { label: 'invite code', timeoutMs: 10_000 });
ev.check('Invite someone shows a code', CODE_RE.test(code), code);
const drawer = await a.page.evaluate(`document.querySelector('[aria-label="Invite code"]')?.innerText ?? ''`);
ev.check('…that "works once and expires on" a date, shown only now', drawer.includes('This code works once and expires on'), drawer);
await a.page.screenshot(ev.shot('invite'));
await a.page.click('Done');

const joined = await connectWindow(b, { url: relay.url, code, name: 'Bruno', device: 'Bruno desktop' });
ev.check('window B connects with it', joined === true);
await b.page.screenshot(ev.shot('b-connected'));
await b.page.navigate('#/team');
const ana = await until(() => b.page.evaluate(`document.querySelector('[data-member="Ana"] .team-relay__dot')?.getAttribute('data-presence') ?? ''`), { label: 'Ana in B', timeoutMs: 15_000 });
ev.check("B's Team screen lists Ana, online", ana === 'online', ana);
await sleep(400);
await b.page.screenshot(ev.shot('b-team'));

ev.save();
process.exit(ev.ok ? 0 : 1);
