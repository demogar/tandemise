import { execFile } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { openDatabase, migrate } from '../../packages/persistence/dist/index.js';
const dir = new URL('./tmp2/', import.meta.url).pathname;
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const N = 150, PROCS = ['A','B','C','D'];

async function scenario(mode) {
  const dbPath = `${dir}${mode}.db`;
  const db = openDatabase({ path: dbPath }); migrate(db);
  if (mode === 'event') {
    db.handle.prepare("INSERT INTO workspaces (id,name,autonomy,concurrency,routing,default_autonomy_level,knowledge,created_at,updated_at) VALUES ('ws1','w','{}','{}','{}','balanced','{}','t','t')").run();
    db.handle.prepare("INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,created_at,updated_at) VALUES ('m1','ws1','t','g','[]','[]','DRAFT','balanced','standard','t','t')").run();
  }
  db.close();
  const startAt = Date.now() + 900;
  const out = await Promise.all(PROCS.map((label) => new Promise((res) => execFile(process.execPath,
    [new URL('./worker2.mjs', import.meta.url).pathname, mode, dbPath, label, String(N)],
    { env: { ...process.env, START_AT: String(startAt) } },
    (err, stdout, stderr) => res(err ? `${label} ERROR ${stderr.trim().split('\n').slice(0,4).join(' | ')}` : stdout.trim())))));
  out.forEach((o) => console.log(' ', mode, o));
  const c = openDatabase({ path: dbPath });
  if (mode === 'lease') {
    const total = c.handle.prepare('SELECT COUNT(*) n, COUNT(DISTINCT resource_key) d FROM resource_leases').get();
    const claimed = out.reduce((a,o)=> a + (JSON.parse(o).wonCount ?? 0), 0);
    console.log(`  => keys=${N} rows=${total.n} distinct=${total.d} totalAcquireSuccesses=${claimed}`,
      claimed === N && total.n === N ? 'EXACTLY-ONE-WINNER-PER-KEY' : 'DOUBLE ACQUISITION');
  } else {
    const r = c.handle.prepare('SELECT COUNT(*) n, COUNT(DISTINCT sequence) d, MAX(sequence) mx FROM run_events').get();
    console.log(`  => rows=${r.n} distinctSeq=${r.d} max=${r.mx}`, (r.n===r.d && r.n===r.mx) ? 'UNIQUE+GAPLESS' : 'PROBLEM');
  }
  c.close();
}
await scenario('lease');
await scenario('event');
