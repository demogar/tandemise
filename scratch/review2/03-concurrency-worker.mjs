// Worker for the two-process concurrency test. argv: <dbPath> <mode> <n>
import { openDatabase, SqliteEventRepository, SqliteLeaseRepository } from '@tandemise/persistence';

const [dbPath, mode, nRaw] = process.argv.slice(2);
const n = Number(nRaw);
const db = openDatabase({ path: dbPath });
const clock = { now: () => new Date().toISOString(), epochMs: () => Date.now() };

if (mode === 'events') {
  const repo = new SqliteEventRepository(db);
  let errors = 0;
  for (let i = 0; i < n; i++) {
    try {
      repo.append({
        id: `ev_${process.pid}_${i}`, workspaceId: 'ws_1', missionId: 'ms_1',
        body: { type: 'note', text: `p${process.pid} #${i}`, level: 'info' },
        createdAt: clock.now(),
      });
    } catch (e) { errors++; if (errors < 3) console.error('APPEND ERROR', String(e).slice(0, 120)); }
  }
  console.log(JSON.stringify({ pid: process.pid, errors }));
}

if (mode === 'lease') {
  const repo = new SqliteLeaseRepository(db, clock);
  let won = 0;
  for (let i = 0; i < n; i++) {
    // Contended: the winner keeps the lease, so only ONE acquire in the whole
    // two-process run may succeed for a given key.
    const lease = repo.acquire(`branch:${i}`, { runId: `run_${process.pid}` }, 600_000);
    if (lease) won++;
  }
  console.log(JSON.stringify({ pid: process.pid, won }));
}

db.close();
