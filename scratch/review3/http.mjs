import { HttpServer } from '../../apps/daemon/dist/http/server.js';
import { Router } from '../../apps/daemon/dist/http/router.js';
import { nullLogger } from '../../packages/shared/dist/index.js';
import { z } from 'zod';
import net from 'node:net';

const TOKEN = 'x'.repeat(43);
const r = new Router();
r.get('/v1/ok', () => ({ ok: true }));
r.get('/v1/boom', () => { const e = new Error('connect ECONNREFUSED /Users/you/.ssh/id_rsa token=SECRETVALUE123'); throw e; });
r.get('/v1/zodquery', (ctx) => z.object({ limit: z.coerce.number().int().max(10) }).parse(Object.fromEntries(ctx.query)));
r.post('/v1/echo', async (ctx) => ctx.body(z.object({ a: z.string() })));

let upgraded = 0;
const http = new HttpServer({ token: TOKEN, router: r, log: nullLogger, onUpgrade: () => { upgraded++; } });
const url = await http.listen();
const H = { authorization: `Bearer ${TOKEN}` };
const get = async (p, h = H) => { const res = await fetch(url + p, { headers: h }); return [res.status, (await res.text()).slice(0, 400)]; };

console.log('auth ok        ', await get('/v1/ok'));
console.log('no token       ', await get('/v1/ok', {}));
console.log('bad token      ', await get('/v1/ok', { authorization: 'Bearer ' + 'y'.repeat(43) }));
console.log('health noauth  ', await get('/v1/health', {}));
console.log('api ver absent ', await get('/v1/ok', H));
console.log('api ver wrong  ', await get('/v1/ok', { ...H, 'x-tandemise-api': '99' }));
console.log('500 leak       ', await get('/v1/boom'));
console.log('bad zod query  ', await get('/v1/zodquery?limit=9999'));
const bad = await fetch(url + '/v1/echo', { method:'POST', headers: { ...H, 'content-type':'application/json' }, body: JSON.stringify({ a: 1 }) });
console.log('bad body       ', bad.status, (await bad.text()).slice(0,200));

// oversized body: is the cap enforced before memory is consumed?
const big = Buffer.alloc(40 * 1024 * 1024, 'a');
const t0 = Date.now();
try {
  const res = await fetch(url + '/v1/echo', { method:'POST', headers: { ...H, 'content-type':'application/json' }, body: big });
  console.log('40MB body      ', res.status, (await res.text()).slice(0,160), `${Date.now()-t0}ms`);
} catch (e) { console.log('40MB body      ', 'fetch error:', String(e).slice(0,120)); }

// unauthenticated websocket upgrade
const raw = (hdrs) => new Promise((res) => {
  const u = new URL(url); const s = net.connect(Number(u.port), u.hostname, () => {
    s.write(`GET /v1/stream HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${hdrs}\r\n`);
  });
  let buf=''; s.on('data', d => { buf += d; res(buf.split('\r\n')[0]); s.destroy(); });
  s.on('close', () => res(buf.split('\r\n')[0] || '(closed, no response)'));
  setTimeout(()=>{ s.destroy(); res(buf.split('\r\n')[0] || '(timeout)'); }, 1500);
});
console.log('upgrade noauth ', await raw('\r\n'), '| onUpgrade calls:', upgraded);
console.log('upgrade auth   ', await raw(`Authorization: Bearer ${TOKEN}\r\n\r\n`), '| onUpgrade calls:', upgraded);

// shutdown with an idle keep-alive connection open
const keep = net.connect(Number(new URL(url).port), '127.0.0.1');
await new Promise(r2 => keep.once('connect', r2));
keep.write('GET /v1/ok HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ' + TOKEN + '\r\nConnection: keep-alive\r\n\r\n');
await new Promise(r2 => keep.once('data', r2));
const t1 = Date.now();
const closed = await Promise.race([http.close().then(()=> 'closed in ' + (Date.now()-t1) + 'ms'), new Promise(r2=>setTimeout(()=>r2('HUNG > 3000ms'), 3000))]);
console.log('close w/ keepalive:', closed);
process.exit(0);
