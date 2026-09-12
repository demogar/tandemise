import { execFile } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { openDatabase, migrate } from '../../packages/persistence/dist/index.js';
const dir = new URL('./tmp3/', import.meta.url).pathname;
rmSync(dir,{recursive:true,force:true}); mkdirSync(dir,{recursive:true});
const dbPath = dir+'l.db';
const db = openDatabase({path:dbPath}); migrate(db);
const past = new Date(Date.now()-60000).toISOString();
const ins = db.handle.prepare('INSERT INTO resource_leases (id,resource_key,holder_run_id,holder_task_id,acquired_at,expires_at,heartbeat_at) VALUES (?,?,?,NULL,?,?,?)');
for (let i=0;i<100;i++) ins.run(`old_${i}`,`stale-${i}`,'dead-run',past,past,past);
db.close();
const startAt = Date.now()+800;
const out = await Promise.all(['A','B','C','D'].map(l=>new Promise(r=>execFile(process.execPath,
  [new URL('./lease-expired-worker.mjs',import.meta.url).pathname, dbPath, l],
  {env:{...process.env,START_AT:String(startAt)}},(e,so,se)=>r(e?`${l} ERR ${se.split('\n')[0]}`:so.trim())))));
out.forEach(o=>console.log(' ',o));
const total = out.reduce((a,o)=>a+(JSON.parse(o).won??0),0);
const c = openDatabase({path:dbPath});
const rows = c.handle.prepare('SELECT COUNT(*) n, COUNT(DISTINCT resource_key) d, COUNT(DISTINCT holder_run_id) h FROM resource_leases').get();
console.log(`  => expiredKeys=100 totalTakeovers=${total} rows=${rows.n} distinctKeys=${rows.d}`, total===100?'EXACTLY-ONE-TAKEOVER-PER-EXPIRED-LEASE':'DOUBLE TAKEOVER');
c.close();
