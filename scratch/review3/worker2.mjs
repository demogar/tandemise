import { openDatabase, SqliteLeaseRepository, SqliteEventRepository } from '../../packages/persistence/dist/index.js';
const [,, mode, dbPath, label, nStr] = process.argv;
const N = Number(nStr);
const db = openDatabase({ path: dbPath });
const clock = { now: () => new Date().toISOString(), epochMs: () => Date.now() };
const spin = (ms) => { const t = Date.now() + ms; while (Date.now() < t) {} };
spin(Math.max(0, Number(process.env.START_AT) - Date.now()));

if (mode === 'lease') {
  const repo = new SqliteLeaseRepository(db, clock);
  const won = [];
  for (let i = 0; i < N; i++) { if (repo.acquire(`key-${i}`, { runId: label }, 600_000)) won.push(i); spin(Math.random()*2); }
  process.stdout.write(JSON.stringify({ label, wonCount: won.length }) + '\n');
} else {
  const repo = new SqliteEventRepository(db);
  const seqs = [];
  for (let i = 0; i < N; i++) {
    seqs.push(repo.append({ id:`evt_${label}_${i}`, workspaceId:'ws1', missionId:'m1',
      body:{type:'note',text:'x',level:'info'}, createdAt: clock.now() }).sequence);
    spin(Math.random()*2);
  }
  process.stdout.write(JSON.stringify({ label, first: seqs.slice(0,5), interleaved: seqs.some((s,i)=> i>0 && s !== seqs[i-1]+1) }) + '\n');
}
db.close();
