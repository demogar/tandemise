import { HttpServer } from '../../apps/daemon/dist/http/server.js';
import { StreamServer } from '../../apps/daemon/dist/http/stream.js';
import { Router } from '../../apps/daemon/dist/http/router.js';
import { InMemoryEventBus, InMemoryProjectionBus } from '../../apps/daemon/dist/buses.js';
import { nullLogger } from '../../packages/shared/dist/index.js';
import WebSocket from 'ws';

const TOKEN='x'.repeat(43);
const events = new InMemoryEventBus(), projections = new InMemoryProjectionBus();
let stream;
const http = new HttpServer({ token:TOKEN, router:new Router(), log:nullLogger, onUpgrade:(q,s,h)=>stream.handleUpgrade(q,s,h) });
const url = await http.listen();
stream = new StreamServer({ server: http.httpServer, log: nullLogger, daemonVersion:'0.1.0', events, projections });

const ws = new WebSocket(url.replace('http','ws') + '/v1/stream', { headers:{ authorization:`Bearer ${TOKEN}` } });
const got = [];
ws.on('message', (m) => got.push(JSON.parse(m.toString())));
await new Promise(r => ws.on('open', r));
const ev = (mid) => ({ id:'e'+Math.random(), workspaceId:'ws1', missionId:mid, taskId:null, runId:null, sequence:1, roleId:null, runtimeProfileId:null, body:{type:'note',text:'x',level:'info'}, createdAt:'t' });
const settle = () => new Promise(r => setTimeout(r, 120));

ws.send(JSON.stringify({ type:'subscribe', missionId:'m1' })); await settle();
got.length=0; events.publish(ev('m1')); events.publish(ev('m2')); await settle();
console.log('subscribed to m1 -> received missions:', got.filter(m=>m.type==='event').map(m=>m.record.missionId));

ws.send(JSON.stringify({ type:'unsubscribe' })); await settle();   // "unsubscribe from everything"
got.length=0; events.publish(ev('m1')); events.publish(ev('m2')); events.publish(ev('m3')); await settle();
console.log('after unsubscribe-all  -> received missions:', got.filter(m=>m.type==='event').map(m=>m.record.missionId),
  got.length ? '<= FIREHOSE (expected none)' : '<= correctly silent');
ws.close(); stream.close(); process.exit(0);
