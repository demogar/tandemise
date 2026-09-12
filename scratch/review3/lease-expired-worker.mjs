import { openDatabase, SqliteLeaseRepository } from '../../packages/persistence/dist/index.js';
const [,, dbPath, label] = process.argv;
const db = openDatabase({ path: dbPath });
const clock = { now: () => new Date().toISOString(), epochMs: () => Date.now() };
const spin=(ms)=>{const t=Date.now()+ms;while(Date.now()<t){}};
spin(Math.max(0, Number(process.env.START_AT)-Date.now()));
const repo = new SqliteLeaseRepository(db, clock);
let won=0; for (let i=0;i<100;i++){ if (repo.acquire(`stale-${i}`, {runId:label}, 600000)) won++; spin(Math.random()*2); }
process.stdout.write(JSON.stringify({label,won})+'\n'); db.close();
