// R6 — Stop the relay: A's Settings → Team relay says offline, "Offline since …". Start it again on the same
// database and port: A goes back to connected by itself.
import { Evidence } from '../../p0/lib/evidence.mjs';
import { relaySettings, relayState, relayText, restartRelay, stopRelay, until, windowFor } from '../common.mjs';

const A = process.env.ACCEPTANCE_SCRATCH;
const a = await windowFor(A, Number(process.env.CDP_PORT));
const ev = new Evidence('R6', 'The relay goes away and comes back; window A follows');

await relaySettings(a);
ev.check('connected before', (await relayState(a)) === 'connected', await relayText(a));
await stopRelay(A);
const offline = await until(async () => (await relayState(a)) === 'offline', { label: 'offline', timeoutMs: 15_000 }).catch(() => false);
const text = await relayText(a);
ev.check('with the relay stopped, Settings says offline', offline === true, text);
ev.check('…"Offline since …"', /Offline since /.test(text), text);
await a.page.screenshot(ev.shot('offline'));
await restartRelay(A);
const back = await until(async () => (await relayState(a)) === 'connected', { label: 'connected again', timeoutMs: 45_000 }).catch(() => false);
ev.check('after it is back, A reconnects by itself', back === true, await relayText(a));
await a.page.screenshot(ev.shot('reconnected'));

ev.save();
process.exit(ev.ok ? 0 : 1);
