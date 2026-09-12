import { openDatabase, migrate, SqliteLeaseRepository, SqliteEventRepository } from '../../packages/persistence/dist/index.js';
const [,, mode, dbPath, label] = process.argv;
const db = openDatabase({ path: dbPath });
const clock = { now: () => new Date().toISOString(), epochMs: () => Date.now() };
const start = Number(process.env.START_AT);
while (Date.now() < start) {}           // spin so both processes hit the DB together

if (mode === 'lease') {
  const repo = new SqliteLeaseRepository(db, clock);
  let won = 0;
  for (let i = 0; i < 300; i++) {
    const l = repo.acquire('branch/main', { runId: label }, 60_000);
    if (l) { won++; repo.release(l.id); }
  }
  process.stdout.write(JSON.stringify({ label, won }) + '\n');
} else {
  const repo = new SqliteEventRepository(db);
  const seqs = [];
  for (let i = 0; i < 300; i++) {
    const r = repo.append({
      id: `evt_${label}_${i}`, workspaceId: 'ws1', missionId: 'm1',
      body: { type: 'note', text: 'x', level: 'info' }, createdAt: clock.now(),
    });
    seqs.push(r.sequence);
  }
  process.stdout.write(JSON.stringify({ label, min: Math.min(...seqs), max: Math.max(...seqs), n: seqs.length }) + '\n');
}
db.close();
