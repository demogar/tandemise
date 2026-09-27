// P3a: outside contributions, part 1 - the pure types, schemas, events and the
// liveness split that every later P3 task builds on. A contribution (a file
// or a link) is one shape wherever it arrives; a workspace handoff link may
// carry a path instead of a url; a skipped plan stage must name a real
// upload; and a parked agent task waits on a person, not the scheduler.
//
//   npm run build && node scratch/p3-contributions-check.mjs
import { SCHEMA_VERSION } from '@tandemise/persistence';

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 700)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);

const D = await import('@tandemise/domain');
const A = await import('@tandemise/artifacts');

section('pure: contributions, links, plans, liveness');

check('decodedSize of 4 base64 chars is 3', D.decodedSize('YWJj') === 3);
check('decodedSize honours padding', D.decodedSize('YQ==') === 1);
check('the cap is 24 MB', D.CONTRIBUTION_MAX_BYTES === 25165824);

const ok = A.handoffSchema.safeParse({ headline: 'h', points: [], links: [{ label: 'Repo', kind: 'workspace', path: 'docs/spec.md' }] });
check('a workspace link may carry a path and no url', ok.success, ok.error?.issues);
const bad = A.handoffSchema.safeParse({ headline: 'h', points: [], links: [{ label: 'PR', kind: 'pr', url: 'https://x/1', path: 'a' }] });
check('a pr link with a path is refused', !bad.success && bad.error.issues.some((i) => /only a workspace link may carry a path/.test(i.message)), bad.success ? bad.data : bad.error.issues);
const file = A.handoffSchema.safeParse({ headline: 'h', points: [], links: [{ label: 'X', kind: 'doc', url: 'file:///etc/passwd' }] });
check('a non-workspace link stays http(s) only', !file.success);
const noUrlNoPath = A.handoffSchema.safeParse({ headline: 'h', points: [], links: [{ label: 'X', kind: 'other' }] });
check('a non-workspace link without a url is refused', !noUrlNoPath.success && noUrlNoPath.error.issues.some((i) => /link url must be a full URL/.test(i.message)), noUrlNoPath.success ? noUrlNoPath.data : noUrlNoPath.error.issues);

// A minimal planned task: the shape validateMissionPlan already accepts
// (copied from the `task` fixture in scratch/p15-setup-check.mjs), parameterised
// by key, output type and dependencies since this check needs several shapes.
const minimalTask = (key, outputType, dependsOn) => ({
  key, title: key, objective: 'o', roleId: key, dependsOn, requiredCapabilities: [], inputArtifacts: [],
  expectedOutputs: [outputType], executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
  approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'block' },
  completionGate: null,
});
const ctx = (extra = {}) => ({ knownRoleIds: new Set(['design']), satisfiableCapabilities: new Set(), ...extra });

const pre = [{ id: 'art_up', type: 'ProductSpec' }];
const plan = {
  summary: 's',
  tasks: [/* a design task depending on nothing */ minimalTask('design', 'DesignBrief', [])],
  skipped: [{ stage: 'product', outputType: 'ProductSpec', artifactId: 'art_up', reason: 'upload' }],
};
const good = D.validateMissionPlan(plan, ctx({ preexistingArtifacts: pre }));
check('a skipped stage naming a real upload validates', good.ok, good.ok ? good.value : good.error);
const badSkip = D.validateMissionPlan({ ...plan, skipped: [{ ...plan.skipped[0], artifactId: 'art_nope' }] }, ctx({ preexistingArtifacts: pre }));
check('a skipped stage naming an unknown artifact is an error', !badSkip.ok && badSkip.error.some((e) => /not an upload of type ProductSpec/.test(e.message)), badSkip.ok ? badSkip.value : badSkip.error);

// taskLiveness is the real per-task classifier (liveness.ts); AWAITING_EXTERNAL
// now splits on executor (T8 wait vs T8b parked agent). `moves` is true, as it
// is for any task in a working mission's row.
const wctx = { byKey: new Map(), carded: new Set(), moves: true };
check('T8: a waiting wait-step is moving', D.taskLiveness({ status: 'AWAITING_EXTERNAL', executor: 'wait' }, wctx).standing === 'moving');
check('T8b: a parked agent task waits on a person', D.taskLiveness({ status: 'AWAITING_EXTERNAL', executor: 'agent' }, wctx).standing === 'waiting');

check('the new events are in the semantic list', ['task.parked_external', 'task.handed_back', 'mission.intake_completed'].every((t) => D.SEMANTIC_EVENT_TYPES.has(t)));

check('P3a adds no migration: SCHEMA_VERSION is still 19', SCHEMA_VERSION === 19, SCHEMA_VERSION);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
console.log('ALL P3 CONTRIBUTIONS CHECKS PASSED');
process.exit(0);
