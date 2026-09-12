/**
 * Every status the domain can produce must be a status the database accepts.
 *
 * `mission_tasks.status` carries a CHECK constraint listing statuses by name.
 * Three were added to the domain without widening it, so `AWAITING_HUMAN` and
 * `AWAITING_EXTERNAL` threw `SQLITE_CONSTRAINT_CHECK` on first write - every
 * workflow with a human or wait step failed on dispatch, and nothing caught it
 * because the workflow tests exercised the compiler rather than the scheduler.
 *
 * This checks the property behaviourally: it writes each value the domain
 * declares and requires the database to take it. Parsing the schema text would
 * have missed the subtler half of the same bug, where a cached schema keeps
 * rejecting a value the stored DDL already allows.
 */
import { mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const { openDatabase, migrate, SCHEMA_VERSION } = await import('../packages/persistence/dist/index.js');
const domain = await import('../packages/domain/dist/index.js');

let passed = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
};

const dir = mkdtempSync(join(tmpdir(), 'tandemise-schema-'));

/** A migrated database with one workspace, mission, task, dependency and run. */
function seeded(path) {
  const db = openDatabase({ path });
  migrate(db);
  db.handle.exec(`
    INSERT INTO workspaces (id,name,autonomy,concurrency,routing,default_autonomy_level,knowledge,created_at,updated_at)
      VALUES ('ws1','W','balanced','{}','{}','balanced','{}','2026-01-01','2026-01-01');
    INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,created_at,updated_at)
      VALUES ('m1','ws1','T','G','[]','[]','EXECUTING','balanced','p','2026-01-01','2026-01-01');
    INSERT INTO mission_tasks (id,mission_id,key,title,objective,role_id,required_capabilities,input_artifacts,expected_outputs,execution_policy,approval_policy,retry_policy,status,created_at,updated_at)
      VALUES ('t1','m1','k1','T1','O','design','[]','[]','[]','{}','{}','{}','RUNNING','2026-01-01','2026-01-01');
    INSERT INTO task_dependencies (task_id,depends_on_key,ordinal) VALUES ('t1','k0',0);
  `);
  return db;
}

// ---------------------------------------------------------------- the property

{
  const db = seeded(join(dir, 'statuses.db'));
  const write = (status) => {
    try {
      db.handle.prepare('UPDATE mission_tasks SET status = ? WHERE id = ?').run(status, 't1');
      return null;
    } catch (e) { return String(e.message ?? e); }
  };

  for (const status of domain.TASK_STATUSES) {
    ok(`mission_tasks accepts ${status}`, write(status) === null, write(status) ?? '');
  }
  ok('mission_tasks still rejects an unknown status', write('NOT_A_STATUS') !== null);
  db.close();
}

// Same property for every other enum the schema pins by name, so the next one
// to drift is caught by this file rather than by a user's mission.
{
  const db = seeded(join(dir, 'enums.db'));
  const cases = [
    ['missions', 'status', domain.MISSION_STATUSES, "UPDATE missions SET status = ? WHERE id = 'm1'"],
    ['approvals', 'kind', domain.APPROVAL_KINDS, null],
    ['approvals', 'status', domain.APPROVAL_STATUSES, null],
    ['artifacts', 'type', domain.ARTIFACT_TYPES, null],
    ['runs', 'status', domain.RUN_STATUSES, null],
  ];
  for (const [table, column, values, sql] of cases) {
    const ddl = db.handle
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table)?.sql ?? '';
    const missing = values.filter((v) => !ddl.includes(`'${v}'`));
    ok(`${table}.${column} lists every domain value`, missing.length === 0, missing.join(', '));
    if (sql !== null) {
      for (const v of values) {
        let err = null;
        try { db.handle.prepare(sql).run(v); } catch (e) { err = String(e.message ?? e); }
        ok(`${table}.${column} accepts ${v}`, err === null, err ?? '');
      }
    }
  }
  db.close();
}

// ------------------------------------------------- upgrade preserves history

{
  const path = join(dir, 'upgrade.db');
  const db = seeded(path);
  // A run references an assignment, a profile and a target this fixture does
  // not build. The point here is that migration 006 leaves child rows alone, so
  // the row only has to exist - the references are switched off while it lands.
  db.handle.pragma('foreign_keys = OFF');
  db.handle.exec(`
    INSERT INTO runs (id,mission_id,task_id,assignment_id,attempt,status,role_id,runtime_profile_id,execution_target_id,started_at)
      VALUES ('r1','m1','t1','a1',1,'RUNNING','design','rp1','et1','2026-01-01');
  `);
  db.handle.pragma('foreign_keys = ON');
  const before = db.handle.prepare('SELECT count(*) AS n FROM task_dependencies').get().n;
  db.close();

  // Re-open and re-migrate: migration 006 must be a no-op the second time, and
  // must not have cascaded any child row away the first time.
  const again = openDatabase({ path });
  const result = migrate(again);
  ok('re-migrating applies nothing', result.applied.length === 0, `applied=[${result.applied}]`);
  ok('task_dependencies survived the upgrade',
     again.handle.prepare('SELECT count(*) AS n FROM task_dependencies').get().n === before);
  ok('runs survived the upgrade',
     again.handle.prepare('SELECT count(*) AS n FROM runs').get().n === 1);
  ok('indexes survived the upgrade',
     again.handle.prepare("SELECT count(*) AS n FROM sqlite_master WHERE tbl_name='mission_tasks' AND type='index'").get().n >= 5);
  ok('integrity_check is clean',
     again.handle.pragma('integrity_check', { simple: true }) === 'ok');
  ok('schema version is current',
     again.handle.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v === SCHEMA_VERSION);
  again.close();
}

// ------------------------------------- the user's own database, if there is one

{
  const live = join(homedir(), '.tandemise', 'tandemise.db');
  if (existsSync(live)) {
    const copy = join(dir, 'live.db');
    copyFileSync(live, copy);
    const db = openDatabase({ path: copy });
    const before = db.handle.prepare('SELECT count(*) AS n FROM mission_tasks').get().n;
    migrate(db);
    let err = null;
    try {
      db.handle.exec("UPDATE mission_tasks SET status = 'AWAITING_HUMAN'");
    } catch (e) { err = String(e.message ?? e); }
    ok('a copy of the real database upgrades and accepts AWAITING_HUMAN', err === null, err ?? '');
    ok('no task was lost upgrading the real database',
       db.handle.prepare('SELECT count(*) AS n FROM mission_tasks').get().n === before);
    db.close();
  } else {
    console.log('  skip live database (none at ~/.tandemise)');
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
