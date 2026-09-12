import { execFile } from 'node:child_process';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
const home = new URL('./tmp5/', import.meta.url).pathname;
rmSync(home,{recursive:true,force:true}); mkdirSync(home,{recursive:true});
const startAt = Date.now()+800;
const out = await Promise.all([1,2,3,4].map(()=>new Promise(r=>execFile(process.execPath,
  [new URL('./lock-worker.mjs',import.meta.url).pathname, home],
  {env:{...process.env,START_AT:String(startAt)}},(e,so,se)=>r(e?('ERR '+se.split('\n').slice(0,3)):so.trim())))));
out.forEach(o=>console.log(' ',o));
console.log('  acquired count:', out.filter(o=>o==='ACQUIRED').length, '(expected 1)');
console.log('  lock file pid:', readFileSync(home+'daemon.lock','utf8'));
