/**
 * Parallel tasks that produce the same artifact type must both reach the task
 * that combines them.
 *
 * Found running a real research mission: web and mobile research each wrote a
 * ProblemBrief, the second superseded the first mission-wide, and the product
 * document reported "no mobile ProblemBrief was provided".
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { upstreamTaskIds, liveArtifacts, supersededBy } = await import(join(root, 'packages/application/dist/support/lineage.js'));

let bad = 0;
const ok = (n, c, d = '') => { if (c) console.log(`  ok   ${n}${d ? '  ' + d : ''}`); else { bad++; console.log(`  FAIL ${n}${d ? '  ' + d : ''}`); } };

const task = (key, dependsOn = [], extra = {}) => ({ id: `tsk_${key}`, key, missionId: 'msn_1', dependsOn, ...extra });
const tasks = [
  task('web'), task('mobile'), task('finance'),
  task('po', ['web', 'mobile', 'finance']),
  task('design'), task('design_revision_1', ['design']), task('architecture', ['design_revision_1']),
];
let artifacts = [];
let n = 0;
const repo = {
  listByMission: () => [...artifacts].reverse(),
  latest: (_m, type) => [...artifacts].reverse().find((a) => a.type === type && !artifacts.some((b) => b.supersedes === a.id)),
};
const taskRepo = { listByMission: () => tasks };
const write = (taskKey, type) => {
  const t = tasks.find((x) => x.key === taskKey);
  const previous = supersededBy(t, type, repo, taskRepo);
  const manifest = { id: `art_${++n}`, taskId: t.id, type, supersedes: previous?.id ?? null };
  artifacts.push(manifest);
  return manifest;
};

console.log('── fan-in: two parallel producers of one type\n');
const webBrief = write('web', 'ProblemBrief');
const mobileBrief = write('mobile', 'ProblemBrief');
ok('the second brief does not supersede its sibling', mobileBrief.supersedes === null);
const live = liveArtifacts(repo, 'msn_1', 'ProblemBrief').map((a) => a.id).sort();
ok('both briefs stay live', live.length === 2 && live.includes(webBrief.id) && live.includes(mobileBrief.id), live.join(','));
const upstream = upstreamTaskIds(tasks.find((t) => t.key === 'po'), tasks);
ok('the combining task sees both producers upstream', upstream.has('tsk_web') && upstream.has('tsk_mobile'));

console.log('\n── a retry replaces its own attempt\n');
const webRetry = write('web', 'ProblemBrief');
ok('same task supersedes its earlier output', webRetry.supersedes === webBrief.id);
ok('the sibling is still live', liveArtifacts(repo, 'msn_1', 'ProblemBrief').some((a) => a.id === mobileBrief.id));

console.log('\n── a revision replaces what it revises\n');
const firstDesign = write('design', 'DesignBrief');
const revised = write('design_revision_1', 'DesignBrief');
ok('the revision supersedes the upstream design', revised.supersedes === firstDesign.id);
const archUpstream = upstreamTaskIds(tasks.find((t) => t.key === 'architecture'), tasks);
const archSees = liveArtifacts(repo, 'msn_1', 'DesignBrief').filter((a) => archUpstream.has(a.taskId)).map((a) => a.id);
ok('downstream reads only the revision', archSees.length === 1 && archSees[0] === revised.id, archSees.join(','));

console.log(`\n${bad === 0 ? 'ALL ARTIFACT LINEAGE CHECKS PASSED' : `${bad} FAILED`}`);
process.exit(bad === 0 ? 0 : 1);
