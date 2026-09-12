import { execFile } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { openDatabase, migrate } from '../../packages/persistence/dist/index.js';

const dir = new URL('./tmp/', import.meta.url).pathname;
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });

async function scenario(mode) {
  const dbPath = `${dir}${mode}.db`;
  const db = openDatabase({ path: dbPath });
  migrate(db);
  if (mode === 'event') {
    db.handle.prepare("INSERT INTO workspaces (id,name,autonomy,concurrency,routing,default_autonomy_level,knowledge,created_at,updated_at) VALUES ('ws1','w','{}','{}','{}','balanced','{}','t','t')").run();
    db.handle.prepare("INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,created_at,updated_at) VALUES ('m1','ws1','t','g','[]','[]','DRAFT','balanced','standard','t','t')").run();
  }
  db.close();

  const startAt = Date.now() + 700;
  const spawn = (label) => new Promise((res) => execFile(process.execPath,
    [new URL('./worker.mjs', import.meta.url).pathname, mode, dbPath, label],
    { env: { ...process.env, START_AT: String(startAt) } },
    (err, stdout, stderr) => res({ label, err: err && String(err).split('\n')[0], stdout: stdout.trim(), stderr: stderr.trim().split('\n').slice(0,3).join(' | ') })));

  const results = await Promise.all([spawn('A'), spawn('B')]);
  for (const r of results) console.log(mode, r.label, r.err ? `ERROR ${r.err} :: ${r.stderr}` : r.stdout);

  const check = openDatabase({ path: dbPath });
  if (mode === 'event') {
    const rows = check.handle.prepare('SELECT COUNT(*) n, COUNT(DISTINCT sequence) d, MAX(sequence) mx FROM run_events').get();
    console.log('event rows:', rows, rows.n === rows.d && rows.n === rows.mx ? '=> sequences unique & gapless' : '=> PROBLEM');
  } else {
    console.log('leases left:', check.handle.prepare('SELECT COUNT(*) n FROM resource_leases').get());
  }
  check.close();
}
await scenario('lease');
await scenario('event');
