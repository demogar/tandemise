// Persistence behaviours + evaluation edge cases.
import {
  openDatabase, migrate, SqliteArtifactRepository, SqliteMissionRepository, SqliteTaskRepository,
} from '@tandemise/persistence';
import { GateFactBuilder, createCommandCheckRunner } from '@tandemise/evaluation';
import { evaluateGate } from '@tandemise/domain';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tnd-repo-'));
const db = openDatabase({ path: join(dir, 't.db') });
migrate(db);
db.handle.exec(`
  INSERT INTO workspaces VALUES ('ws_1','W',NULL,'{}','{}','{}','balanced','{}','t','t');
  INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,created_at,updated_at)
    VALUES ('ms_1','ws_1','T','G','[]','[]','EXECUTING','balanced','standard','t','t');
`);
const clock = { now: () => '2026-01-01T00:00:00.000Z', epochMs: () => 0 };
const artifacts = new SqliteArtifactRepository(db);

const mk = (id, supersedes = null, createdAt = '2026-01-01T00:00:00.000Z') => ({
  id, workspaceId: 'ws_1', missionId: 'ms_1', taskId: null, createdByRunId: null,
  type: 'ChangeSet', title: `t ${id}`, contentRef: `${id}.md`, mediaType: 'text/markdown',
  sha256: 'x', byteSize: 1, schemaVersion: 1, sourceRefs: [], supersedes, summary: null, createdAt,
});

// -------------------------------------------------- A: latest excludes superseded
artifacts.create(mk('art_1', null, '2026-01-01T00:00:00.000Z'));
artifacts.create(mk('art_2', 'art_1', '2026-01-02T00:00:00.000Z'));
console.log('A. latest() after supersession :', artifacts.latest('ms_1', 'ChangeSet')?.id, '(want art_2)');
// The superseding artifact is later. Now supersede art_2 with an OLDER-dated one:
artifacts.create(mk('art_3', 'art_2', '2025-12-01T00:00:00.000Z'));
console.log('   latest() picks            :', artifacts.latest('ms_1', 'ChangeSet')?.id, '(only art_3 is live)');
console.log('   listByMission returns all :', artifacts.listByMission('ms_1', 'ChangeSet').map((a) => a.id));
console.log('   manifest exposes supersededBy?:', 'supersededBy' in artifacts.get('art_1'));

// --------------------------------------------------------- B: FTS search injection
db.handle.prepare("UPDATE artifacts SET title='onboarding funnel' WHERE id='art_3'").run();
for (const q of ['onboa', '"', 'NEAR(a b)', 'a OR b*', '*']) {
  try {
    const n = artifacts.search('ws_1', q).length;
    console.log(`B. search(${JSON.stringify(q)}) -> ${n} rows`);
  } catch (e) { console.log(`B. search(${JSON.stringify(q)}) THREW ${String(e).slice(0, 90)}`); }
}

// ------------------------------------------------------- C: corrupt JSON columns
const missions = new SqliteMissionRepository(db, clock);
db.handle.prepare("UPDATE missions SET constraints='{not json', success_criteria='null' WHERE id='ms_1'").run();
const m = missions.get('ms_1');
console.log('C. corrupt JSON degrades     :', JSON.stringify({ constraints: m.constraints, successCriteria: m.successCriteria }));

// -------------------------------------------------------- D: partial update merge
const tasks = new SqliteTaskRepository(db, clock);
tasks.add({
  id: 'tk_1', missionId: 'ms_1', key: 'k', title: 'Title', objective: 'Obj', roleId: 'dev',
  dependsOn: ['a', 'a', 'b'], requiredCapabilities: ['fs.read'], inputArtifacts: [], expectedOutputs: [],
  executionPolicy: { isolation: 'worktree', maxWallTimeMs: 5, capabilities: [] }, approvalPolicy: {},
  retryPolicy: {}, completionGate: null, status: 'PENDING', statusReason: 'because', attempts: 0,
  remediatesTaskId: null, orderHint: 0, createdAt: 't', updatedAt: 't', startedAt: null, finishedAt: null,
});
const after = tasks.update('tk_1', { status: 'RUNNING', statusReason: undefined, title: undefined });
console.log('D. patch with explicit undefined keeps stored values:',
  after.status === 'RUNNING' && after.statusReason === 'because' && after.title === 'Title');
console.log('   duplicate dependsOn collapsed:', JSON.stringify(after.dependsOn));

// -------------------------------------------------- E: check runner + timed out
const runner = createCommandCheckRunner({
  clock,
  execute: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 600000, timedOut: true }),
});
const r = await runner.run({ name: 'checks.tests', command: 'npm test' },
  { missionId: 'ms_1', taskId: 'tk_1', runId: null, cwd: '/tmp' });
console.log('E. timed-out check outcome   :', r.outcome, '| detail:', r.detail);

// ------------------------------------------- F: gate facts — missing / all-SKIP
const noFacts = evaluateGate('checks.typecheck == PASS && artifact.ChangeSet.exists', {});
console.log('F. unmeasured facts          :', JSON.stringify(noFacts));
const allSkip = new GateFactBuilder()
  .withQa({ criteria: [{ id: 'c1', outcome: 'SKIP' }, { id: 'c2', outcome: 'SKIP' }], blockingDefects: 0 })
  .withSecurityChecks([], [])
  .build();
console.log('   all-SKIP coverage         :', allSkip['qa.acceptance_criteria_coverage'],
  '| security.required_checks:', allSkip['security.required_checks']);

// ------------------------------- G: approval aggregation is order-dependent
const ap = (kind, status) => ({ id: `ap_${status}`, kind, status });
const a1 = new GateFactBuilder().withApprovals([ap('release', 'APPROVED'), ap('release', 'CANCELLED')]).build();
const a2 = new GateFactBuilder().withApprovals([ap('release', 'CANCELLED'), ap('release', 'APPROVED')]).build();
console.log('G. same approvals, two orders :', a1['approval.release_candidate'], 'vs', a2['approval.release_candidate']);

db.close();
