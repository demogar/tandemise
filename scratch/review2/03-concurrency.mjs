// F: is event sequence assignment atomic across processes? is lease acquire race-free?
import { openDatabase, migrate } from '@tandemise/persistence';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tnd-conc-'));
const dbPath = join(dir, 'test.db');
const db = openDatabase({ path: dbPath });
migrate(db);
db.handle.exec(`
  INSERT INTO workspaces VALUES ('ws_1','W',NULL,'{}','{}','{}','balanced','{}','t','t');
  INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,created_at,updated_at)
    VALUES ('ms_1','ws_1','T','G','[]','[]','EXECUTING','balanced','standard','t','t');
`);

const worker = join(import.meta.dirname, '03-concurrency-worker.mjs');
const runPair = (mode, n) => Promise.all([0, 1].map(() => new Promise((res) => {
  let out = '';
  const p = spawn(process.execPath, [worker, dbPath, mode, String(n)], { cwd: process.cwd() });
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => process.stderr.write(d));
  p.on('close', () => res(out.trim()));
})));

// ------------------------------------------------------------------- events
const N = 300;
console.log(await runPair('events', N));
const rows = db.handle.prepare('SELECT COUNT(*) c, COUNT(DISTINCT sequence) d, MIN(sequence) mn, MAX(sequence) mx FROM run_events').get();
console.log('EVENTS: rows=%d distinct_sequences=%d min=%d max=%d', rows.c, rows.d, rows.mn, rows.mx);
console.log('  every append landed with a unique, gapless sequence:',
  rows.c === 2 * N && rows.d === rows.c && rows.mn === 1 && rows.mx === rows.c);

// ------------------------------------------------------------------- leases
db.handle.exec('DELETE FROM resource_leases');
const K = 400;
const leaseOut = await runPair('lease', K);
const wins = leaseOut.map((o) => JSON.parse(o).won).reduce((a, b) => a + b, 0);
const rowCount = db.handle.prepare('SELECT COUNT(*) c FROM resource_leases').get().c;
console.log('LEASES: contended keys=%d  total successful acquires=%d  rows=%d', K, wins, rowCount);
console.log('  exactly one winner per key (no double ownership):', wins === K && rowCount === K);

db.close();
console.log('db =', dbPath);
