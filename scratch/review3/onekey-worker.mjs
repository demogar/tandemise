import { openDatabase, SqliteLeaseRepository } from '../../packages/persistence/dist/index.js';
const [,, dbPath, label] = process.argv;
const db = openDatabase({ path: dbPath });
const clock = { now: () => new Date().toISOString(), epochMs: () => Date.now() };
const spin=(ms)=>{const t=Date.now()+ms;while(Date.now()<t){}};
spin(Math.max(0, Number(process.env.START_AT)-Date.now()));
const repo = new SqliteLeaseRepository(db, clock);
const wins=[]; const until = Date.now()+2500;
while (Date.now() < until) { const l = repo.acquire('the-branch', {runId:label}, 40); if (l) wins.push([l.acquiredAt, l.expiresAt, label]); spin(Math.random()*3); }
process.stdout.write(JSON.stringify(wins)+'\n'); db.close();
