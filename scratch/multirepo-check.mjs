/**
 * A mission that spans more than one of a project's repositories.
 *
 * A project is often several repositories that ship together - Beveloce is web,
 * mobile and tooling - and one change lands in more than one of them. This
 * drives the real planner output through the real materializer, validator and
 * executor lookups, because the failure it guards against is silent: a task
 * running in the wrong checkout looks exactly like a task running.
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
};

const { materializePlan } = await import('../packages/application/dist/planning/materialize.js');
const { validateMissionPlan } = await import('../packages/domain/dist/plan.js');
const { buildPlannerPrompt } = await import('../packages/application/dist/planning/prompt.js');
const { parsePlanResponse } = await import('../packages/application/dist/planning/parse.js');
const { findPreset, DEFAULT_PRESET_ID } = await import('../packages/application/dist/planning/presets.js');
const preset = findPreset(DEFAULT_PRESET_ID);

const repos = [
  { id: 'repo_web', workspaceId: 'ws1', name: 'beveloce-web', path: '/x/beveloce-web', defaultBranch: 'main' },
  { id: 'repo_mobile', workspaceId: 'ws1', name: 'beveloce-mobile', path: '/x/beveloce-mobile', defaultBranch: 'main' },
  { id: 'repo_tooling', workspaceId: 'ws1', name: 'beveloce-tooling', path: '/x/beveloce-tooling', defaultBranch: 'main' },
];
const clock = { now: () => '2026-09-12T00:00:00.000Z' };

console.log('── the planner is told what it may target');
const prompt = buildPlannerPrompt({
  mission: { title: 'x', goal: 'g', constraints: [], successCriteria: [], autonomy: 'balanced' },
  repository: repos[0], repositories: repos, roles: [], preset,
  availableCapabilities: [], repositoryContext: null,
});
ok('prompt lists every repository', repos.every((r) => prompt.includes(r.name)));
ok('prompt explains the cross-repository rule', prompt.includes('cannot see another'));
const single = buildPlannerPrompt({
  mission: { title: 'x', goal: 'g', constraints: [], successCriteria: [], autonomy: 'balanced' },
  repository: repos[0], repositories: [repos[0]], roles: [], preset,
  availableCapabilities: [], repositoryContext: null,
});
ok('a one-repository project is not told about a choice it lacks', !single.includes('more than one repository'));

console.log('\n── a plan naming repositories by name');
const raw = JSON.stringify({
  summary: 'Ship the coaching change across web and mobile.',
  tasks: [
    { key: 'api_change', title: 'API', objective: 'o', roleId: 'engineer', repository: 'beveloce-web', dependsOn: [] },
    { key: 'mobile_change', title: 'Mobile', objective: 'o', roleId: 'engineer', repository: 'Beveloce-Mobile', dependsOn: ['api_change'] },
    { key: 'release_notes', title: 'Notes', objective: 'o', roleId: 'product', dependsOn: ['mobile_change'] },
  ],
});
const parsed = parsePlanResponse(raw);
ok('plan parses with repository names', parsed.ok, parsed.ok ? '' : JSON.stringify(parsed.error));

const validated = validateMissionPlan(parsed.value, {
  knownRoleIds: new Set(['engineer', 'product']),
  satisfiableCapabilities: new Set(),
  knownRepositoryNames: new Set(repos.map((r) => r.name.toLowerCase())),
});
ok('a plan naming real repositories validates', validated.ok,
  validated.ok ? '' : validated.error.filter((i) => i.severity === 'error').map((i) => i.message).join('; '));

const bad = validateMissionPlan(parsePlanResponse(JSON.stringify({
  summary: 's',
  tasks: [{ key: 'oops', title: 't', objective: 'o', roleId: 'engineer', repository: 'beveloce-desktop', dependsOn: [] }],
})).value, {
  knownRoleIds: new Set(['engineer']),
  satisfiableCapabilities: new Set(),
  knownRepositoryNames: new Set(repos.map((r) => r.name.toLowerCase())),
});
const repoError = bad.ok ? null : bad.error.find((i) => i.message.includes('Unknown repository'));
ok('a repository the project does not have is refused', repoError !== undefined && repoError !== null,
  repoError?.message ?? 'accepted silently');

console.log('\n── materializing resolves names to ids');
const tasks = materializePlan(parsed.value, 'm1', clock, repos);
const byKey = Object.fromEntries(tasks.map((t) => [t.key, t]));
ok('web task targets beveloce-web', byKey.api_change.repositoryId === 'repo_web', String(byKey.api_change.repositoryId));
ok('mobile task targets beveloce-mobile (case-insensitive)', byKey.mobile_change.repositoryId === 'repo_mobile', String(byKey.mobile_change.repositoryId));
ok('a task naming none inherits the mission', byKey.release_notes.repositoryId === null, String(byKey.release_notes.repositoryId));
ok('the dependency graph is still one graph', byKey.mobile_change.dependsOn.includes('api_change') && byKey.release_notes.dependsOn.includes('mobile_change'));

console.log('\n── an existing database survives the upgrade');
{
  const { openDatabase } = await import('../packages/persistence/dist/database.js');
  const { migrate, MIGRATIONS, schemaVersion } = await import('../packages/persistence/dist/migrations/index.js');
  const home = mkdtempSync(join(tmpdir(), 'tandemise-mig-'));
  const file = join(home, 'db.sqlite');

  // Bring a database up to v1 only, as an install from before this change.
  const db = openDatabase({ path: file });
  migrate(db, undefined, MIGRATIONS.filter((m) => m.version === 1));
  ok('starts at the old schema version', schemaVersion(db) === 1, String(schemaVersion(db)));

  const columnsBefore = db.handle.prepare('PRAGMA table_info(mission_tasks)').all().map((c) => c.name);
  ok('old schema has no repository column', !columnsBefore.includes('repository_id'));

  const result = migrate(db, undefined, MIGRATIONS);
  ok('upgrade applies cleanly', result.from === 1 && result.applied.includes(2), JSON.stringify(result));
  const columnsAfter = db.handle.prepare('PRAGMA table_info(mission_tasks)').all().map((c) => c.name);
  ok('repository column is added', columnsAfter.includes('repository_id'));
  ok('nothing else was dropped', columnsBefore.every((c) => columnsAfter.includes(c)));
  ok('re-running is a no-op', migrate(db, undefined, MIGRATIONS).applied.length === 0);
  db.handle.close();
  rmSync(home, { recursive: true, force: true });
}

console.log('\n' + '─'.repeat(60));
console.log(failures.length === 0
  ? `ALL ${passed} MULTI-REPO CHECKS PASSED`
  : `${passed} passed, ${failures.length} FAILED:\n  - ${failures.join('\n  - ')}`);
process.exit(failures.length === 0 ? 0 : 1);
