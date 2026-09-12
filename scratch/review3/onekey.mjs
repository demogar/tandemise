import { execFile } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { openDatabase, migrate } from '../../packages/persistence/dist/index.js';
const dir = new URL('./tmp4/', import.meta.url).pathname;
rmSync(dir,{recursive:true,force:true}); mkdirSync(dir,{recursive:true});
const dbPath = dir+'l.db'; const db = openDatabase({path:dbPath}); migrate(db); db.close();
const startAt = Date.now()+800;
const out = await Promise.all(['A','B','C','D'].map(l=>new Promise(r=>execFile(process.execPath,
  [new URL('./onekey-worker.mjs',import.meta.url).pathname, dbPath, l],
  {env:{...process.env,START_AT:String(startAt)},maxBuffer:1e8},(e,so,se)=>r(e?'[]':so.trim())))));
const wins = out.flatMap(o=>JSON.parse(o)).sort((a,b)=>a[0]<b[0]?-1:1);
let overlaps=0, byProc={};
for (const w of wins) byProc[w[2]]=(byProc[w[2]]||0)+1;
for (let i=1;i<wins.length;i++) if (wins[i][0] < wins[i-1][1]) overlaps++;  // started before predecessor expired
console.log(`single key, 4 processes, TTL 40ms: totalAcquisitions=${wins.length}`, byProc);
console.log(`overlapping holding windows: ${overlaps}`, overlaps===0?'NO DOUBLE OWNERSHIP':'DOUBLE OWNERSHIP');
