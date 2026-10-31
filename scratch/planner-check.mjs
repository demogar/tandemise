// The planner and risk-based merge, phase 1: the gate language for factory
// rules, task profiles, lanes, modules, persistence, the factory source and the
// planner service (docs/superpowers/specs/2026-10-30-planner-and-merge-design.md).
//
//   npm run build && node scratch/planner-check.mjs
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const D = await import('@tandemise/domain');
const app = await import('@tandemise/application');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const attempt = async (label, fn) => {
  try { await fn(); } catch (e) { failures.push(label); console.log(`  FAIL ${label} threw: ${e?.stack ?? e}`); }
};

await attempt('gate language', async () => {
  section('gate language');
  const sum = 'change.lines_added + change.lines_removed > 400';
  check('a sum compares', D.evaluateGate(sum, { 'change.lines_added': 300, 'change.lines_removed': 101 }).passed === true);
  check('a sum under the bound is false', D.evaluateGate(sum, { 'change.lines_added': 300, 'change.lines_removed': 100 }).passed === false);
  check('a sum with a missing operand is false', D.evaluateGate(sum, { 'change.lines_added': 300 }).passed === false);
  const call = 'item.keywords_any("typo", "rename")';
  check('a predicate call reads its arguments', D.evaluateGate(call, {}, { 'item.keywords_any': (a) => a.includes('typo') }).passed === true);
  const missing = D.evaluateGate(call, {});
  check('a call with no predicate is not measured', missing.passed === false && missing.detail.includes('is not measured'), missing.detail);
  const deps = D.gateDependencies('profile.areas_any("auth") && profile.risk == "high"');
  check('dependencies name a call with ()', eq(deps, ['profile.areas_any()', 'profile.risk']), deps);
  const stepLint = D.lintGate('profile.risk == "high"', { stepKey: 'implement', outputs: [], independentOf: false });
  check('a plan fact in a step gate is refused', stepLint[0]?.code === 'not_step_scope', stepLint);
  const callLint = D.lintGate('item.keywords_any("x")', { stepKey: 'implement', outputs: [], independentOf: false });
  check('a call in a step gate is refused', callLint[0]?.code === 'not_step_scope', callLint);
  check('a plan rule may call a plan predicate', eq(D.lintRule('item.keywords_any("typo")', 'plan'), []), D.lintRule('item.keywords_any("typo")', 'plan'));
  check('a plan rule may not read a ship fact', D.lintRule('change.files > 3', 'plan')[0]?.code === 'not_rule_scope');
  check('a ship rule reads ship facts and step checks', eq(D.lintRule('ci.state == PASS && checks.tests != FAIL', 'ship'), []), D.lintRule('ci.state == PASS && checks.tests != FAIL', 'ship'));
  check('a plan rule may not read a step fact', D.lintRule('checks.tests == PASS', 'plan')[0]?.code === 'not_rule_scope');
  check('change.files is a ship fact', D.factDefinition('change.files')?.scope === 'ship');
  check('item.prefix is a plan fact', D.factDefinition('item.prefix')?.scope === 'plan');
  const presets = [
    ['SPEC', app.SPEC_CRITERIA_GATE, { stepKey: 'spec', outputs: ['ProductSpec'], independentOf: false }],
    ['QA', app.QA_CRITERIA_GATE, { stepKey: 'qa', outputs: ['QAReport'], independentOf: false }],
    ['RELEASE', app.RELEASE_CRITERIA_GATE, { stepKey: 'release', outputs: ['ReleaseCandidate'], independentOf: false }],
  ];
  for (const [name, gate, step] of presets) {
    check(`the ${name} preset gate still lints clean`, typeof gate === 'string' && eq(D.lintGate(gate, step), []), [gate, D.lintGate(gate ?? '', step)]);
  }
});

// The spec's §3 planner.yaml as an object, plus the tracker maps Task 4 ships.
const SPEC_PLANNER = {
  version: 1,
  areas: [
    { name: 'migrations', paths: ['**/migrations/**', '**/*.sql'], sensitivity: 'critical' },
    { name: 'auth', paths: ['**/auth/**', '**/session*/**', '**/*oauth*'], sensitivity: 'critical', skills: ['security-review'] },
    { name: 'payments', paths: ['**/billing/**', '**/payment*/**', '**/stripe*/**'], sensitivity: 'critical' },
    { name: 'ci-and-infra', paths: ['.github/**', 'infra/**', '**/Dockerfile', '**/*.tf', '**/docker-compose*.yml'], sensitivity: 'critical' },
    { name: 'dependencies', paths: ['**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/go.sum', '**/Cargo.lock'], sensitivity: 'sensitive' },
    { name: 'desktop-ui', paths: ['apps/desktop/src/renderer/**'], sensitivity: 'none', skills: ['frontend-design'] },
    { name: 'docs', paths: ['docs/**', '**/*.md'], sensitivity: 'none' },
  ],
  trackerTypes: { Bug: 'fix', Feature: 'feature', Task: 'chore', Chore: 'chore', Docs: 'docs', Security: 'security' },
  labels: { bug: 'fix', enhancement: 'feature', dependencies: 'deps', documentation: 'docs', security: 'security' },
  profile: { rules: [
    { when: 'item.prefix == "docs"', set: { type: 'docs', size: 'xs' } },
    { when: 'item.keywords_any("typo", "copy", "rename")', set: { size: 'xs' } },
    { when: 'item.keywords_any("migrate", "migration", "schema")', set: { risk: 'high' } },
    { when: 'item.keywords_any("redesign", "rewrite", "new screen")', set: { type: 'feature', size: 'l' } },
  ] },
  lanes: [
    { when: 'profile.risk == "high" || profile.size == "l"', lane: 'careful' },
    { when: 'profile.risk == "low" && (profile.size == "xs" || profile.size == "s")', lane: 'quick' },
    { lane: 'standard' },
  ],
  laneWorkflows: { quick: 'quick', standard: 'standard', careful: 'careful' },
  byType: { fix: { standard: 'fix', careful: 'fix-careful' } },
  modules: [
    { name: 'security-review', when: 'profile.areas_any("auth", "payments")', add: { step: { key: 'security_review', class: 'review', role: 'review', after: 'implement', skills: ['security-review'], gate: 'artifact.ReviewReport.exists && review.blocking_findings == 0' } } },
    { name: 'build-must-pass', when: 'profile.areas_any("migrations", "ci-and-infra")', add: { gateClause: { step: 'implement', clause: 'checks.build == PASS' } } },
    { name: 'ui-look', when: 'profile.areas_any("desktop-ui") && profile.type == "feature"', add: { approval: { step: 'implement', when: 'after', reason: 'A person looks at new screens before they ship.' } } },
  ],
  holdApproval: { minTasks: 5, rate: 0.4 },
  tiebreak: 'on',
};

const item = (o = {}) => ({ title: '', description: '', trackerType: null, labels: [], sources: [], criteria: 0, ...o });
const input = (o = {}) => ({ item: item(o.item), paths: o.paths ?? [], repos: o.repos ?? [], projectRepos: o.projectRepos ?? 1, history: null, person: o.person ?? 'auto', tiebreak: o.tiebreak ?? null, basis: 'predicted' });

await attempt('profiles', async () => {
  section('profiles');
  const parsed = D.parsePlannerConfig(SPEC_PLANNER);
  check('the spec planner parses with no problems', parsed.problems.length === 0, parsed.problems);
  const cfg = parsed.config;
  const rows = [
    ['docs title', input({ item: { title: 'docs: fix the install steps' } }), ['docs', 'xs', 'low', 'quick']],
    ['bug typo', input({ item: { trackerType: 'Bug', title: 'Fix typo in settings title' } }), ['fix', 'xs', 'low', 'quick']],
    ['billing feature', input({ item: { trackerType: 'Feature', title: 'Invoices page', criteria: 3 }, paths: ['apps/web/src/billing/page.tsx'] }), ['feature', 'm', 'high', 'careful']],
    ['deps label', input({ item: { labels: ['dependencies'], title: 'Bump lodash' }, paths: ['package-lock.json'] }), ['deps', 's', 'medium', 'standard']],
    ['migrate', input({ item: { title: 'Migrate users table', criteria: 2 } }), ['unknown', 'm', 'high', 'careful']],
    ['billing, you chose quick', input({ item: { trackerType: 'Feature', title: 'Invoices page', criteria: 3 }, paths: ['apps/web/src/billing/page.tsx'], person: 'quick' }), ['feature', 'm', 'high', 'quick']],
    ['bug typo + tiebreak payments', input({ item: { trackerType: 'Bug', title: 'Fix typo in settings title' }, tiebreak: { type: 'fix', size: 'xs', areas: ['payments'], why: 'mentions checkout' } }), ['fix', 'xs', 'high', 'careful']],
    ['bug typo in two repos', input({ item: { trackerType: 'Bug', title: 'Fix typo in settings title' }, repos: ['web', 'api'], projectRepos: 2 }), ['fix', 'm', 'low', 'standard']],
  ];
  const profiles = [];
  for (const [label, inp, [type, size, risk, lane]] of rows) {
    const p = D.profileTask(inp, cfg);
    const l = D.chooseLane(p, cfg, inp.person);
    profiles.push(p);
    check(`${label} → ${type} · ${size} · ${risk} · ${lane}`, p.type === type && p.size === size && p.risk === risk && l.lane === lane, { type: p.type, size: p.size, risk: p.risk, lane: l.lane, signals: p.signals });
  }
  check('your Quick keeps the sensitivity floor, and says so', profiles[5].signals.some((s) => s.name === 'sensitivity floor') && profiles[5].risk === 'high', profiles[5].signals);
  check('a person\'s choice marks the source', profiles[5].source === 'person' && profiles[0].source === 'rules' && profiles[6].source === 'rules+model');
  check('every contribution is a signal', profiles[1].signals.some((s) => s.name === 'tracker type' && s.value === 'Bug' && s.effect === 'type fix'), profiles[1].signals);
  check('tiebreak: type unknown', D.tiebreakReason(rows[4][1], profiles[4]) === 'type_unknown');
  check('tiebreak: not for a clear bug', D.tiebreakReason(rows[1][1], profiles[1]) === null);
  const noPaths = input({ item: { trackerType: 'Bug', title: 'Login fails' }, projectRepos: 2 });
  check('tiebreak: no paths, many repos', D.tiebreakReason(noPaths, D.profileTask(noPaths, cfg)) === 'no_paths_many_repos');
  const clash = input({ item: { trackerType: 'Bug', labels: ['enhancement'], title: 'x' } });
  check('tiebreak: two signals disagree', D.tiebreakReason(clash, D.profileTask(clash, cfg)) === 'rules_disagree');
  const failed = D.profileTask({ ...input({ item: { title: 'Do the thing' } }), tiebreakFailed: 'not json' }, cfg);
  check('a failed tiebreak takes the conservative default and says so', failed.size === 'm' && failed.risk === 'medium' && failed.type === 'unknown' && failed.signals.some((s) => s.effect.includes('conservative default')), failed);
  check('a tiebreak saying low never lowers the floor', D.profileTask(input({ item: { title: 'x' }, paths: ['db/migrations/1.sql'], tiebreak: { type: 'fix', size: 'xs', areas: [], why: 'small' } }), cfg).risk === 'high');
  check('history of reverts raises risk', D.profileTask({ ...input({ item: { trackerType: 'Bug', title: 'Fix typo' } }), history: { medianSize: 'xs', revertRate: 0.5, holdRate: 0, n: 4 } }, cfg).risk === 'medium');
});

await attempt('lanes', async () => {
  section('lanes');
  const cfg = D.parsePlannerConfig(SPEC_PLANNER).config;
  check('a type has its own standard workflow', D.laneWorkflowId('standard', 'fix', cfg) === 'fix');
  check('and its own careful one', D.laneWorkflowId('careful', 'fix', cfg) === 'fix-careful');
  check('other types use the lane workflow', D.laneWorkflowId('quick', 'docs', cfg) === 'quick');
  const p = D.profileTask(input({ item: { title: 'docs: x' } }), cfg);
  check('your Careful wins over the rules', eq(D.chooseLane(p, cfg, 'careful'), { lane: 'careful', because: 'you chose it' }));
  const bad = D.parsePlannerConfig({ ...SPEC_PLANNER, profile: { rules: [{ when: 'item.keywords_any("x"', set: { size: 'l' } }, ...SPEC_PLANNER.profile.rules] } });
  check('a rule that does not parse is reported at its path', bad.problems.length === 1 && bad.problems[0].path === 'profile.rules.0.when', bad.problems);
  check('and the other rules still apply', bad.config.profile.rules.length === 4 && D.profileTask(input({ item: { title: 'docs: x' } }), bad.config).size === 'xs');
  const shipRead = D.parsePlannerConfig({ lanes: [{ when: 'change.files > 3', lane: 'careful' }, { lane: 'standard' }] });
  check('a lane rule reading a ship fact is dropped', shipRead.problems[0]?.path === 'lanes.0.when' && shipRead.config.lanes.length === 1, shipRead.problems);
  check('a broken file falls back and says so', D.parsePlannerConfig({ areas: 'nope' }).problems.length === 1);
  check('step class from role', D.stepClassFor({ roleId: 'qa' }) === 'verify' && D.stepClassFor({ roleId: 'x', executor: 'ship' }) === 'ship' && D.stepClassFor({ roleId: 'review', stepClass: 'investigate' }) === 'investigate' && D.stepClassFor({ roleId: 'custom' }) === 'implement');
  check('glob: migrations', D.matchGlob('**/migrations/**', 'db/migrations/0042_add_index.sql') === true);
  check('glob: terraform', D.matchGlob('**/*.tf', 'infra/main.tf') === true);
  check('glob: docs/** is not src/docs.ts', D.matchGlob('docs/**', 'src/docs.ts') === false);
  check('glob: {a,b} and top level', D.matchGlob('**/*.{ts,tsx}', 'a/b.tsx') && D.matchGlob('**/.env*', '.env.local') && !D.matchGlob('CODEOWNERS', 'x/CODEOWNERS'));
});

await attempt('modules only add', async () => {
  section('modules only add');
  const cfg = D.parsePlannerConfig(SPEC_PLANNER).config;
  const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rnd = mulberry32(53);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const GATES = [null, 'artifact.ChangeSet.exists', 'checks.tests == PASS', '(artifact.ChangeSet.exists) && checks.lint != FAIL'];
  const mk = (key, deps) => ({
    key, title: key, objective: key, roleId: pick(['development', 'review', 'qa']), dependsOn: deps, requiredCapabilities: [], inputArtifacts: [], expectedOutputs: [],
    executionPolicy: { isolation: 'worktree', maxWallTimeMs: 1000, capabilities: [] },
    approvalPolicy: { beforeStart: rnd() < 0.2, onCompletion: rnd() < 0.2 },
    retryPolicy: { maxAttempts: 1 + Math.floor(rnd() * 3), backoffMs: 0, onExhausted: 'block' },
    completionGate: pick(GATES),
    ...(rnd() < 0.3 ? { skillRefs: [{ name: 'tdd', version: 'latest' }] } : {}),
  });
  const ctx = D.profileRuleContext({ type: 'feature', size: 'm', risk: 'high', areas: [{ name: 'auth', sensitivity: 'critical' }, { name: 'migrations', sensitivity: 'critical' }, { name: 'desktop-ui', sensitivity: 'none' }], repos: [], signals: [], source: 'rules', basis: 'predicted' });
  let bad = 0;
  let firstBad = null;
  for (let n = 0; n < 200; n++) {
    const count = 1 + Math.floor(rnd() * 6);
    const tasks = [];
    for (let i = 0; i < count; i++) tasks.push(mk(i === 0 ? 'implement' : `t${i}`, tasks.length > 0 && rnd() < 0.7 ? [pick(tasks).key] : []));
    const keys = tasks.map((t) => t.key);
    const generated = Array.from({ length: Math.floor(rnd() * 4) }, (_, i) => {
      const step = pick(keys);
      const kind = pick(['gateClause', 'approval', 'skills', 'maxAttempts', 'step']);
      const add = kind === 'gateClause' ? { gateClause: { step, clause: pick(['checks.build == PASS', 'review.blocking_findings == 0']) } }
        : kind === 'approval' ? { approval: { step, when: pick(['before', 'after']), reason: 'r' } }
          : kind === 'skills' ? { skills: { step, skills: ['frontend-design'] } }
            : kind === 'maxAttempts' ? { maxAttempts: { step, atLeast: 1 + Math.floor(rnd() * 4) } }
              : { step: { key: `extra_${i}`, role: 'review', after: step, skills: [] } };
      return { name: `gen-${i}`, when: 'true', add };
    });
    const modules = [...cfg.modules.filter(() => rnd() < 0.6), ...generated];
    const out = D.applyModules({ summary: 's', tasks }, modules, ctx.facts, ctx.predicates);
    for (const before of tasks) {
      const after = out.plan.tasks.find((t) => t.key === before.key);
      const ok = after !== undefined
        && D.gateImplies(before.completionGate, after.completionGate)
        && (!before.approvalPolicy.beforeStart || after.approvalPolicy.beforeStart)
        && (!before.approvalPolicy.onCompletion || after.approvalPolicy.onCompletion)
        && (before.skillRefs ?? []).every((s) => (after.skillRefs ?? []).some((a) => a.name === s.name))
        && after.retryPolicy.maxAttempts >= before.retryPolicy.maxAttempts;
      if (!ok) { bad++; firstBad ??= { before, after, modules: modules.map((m) => m.name) }; }
    }
  }
  check('200 random plans: nothing disappears, gates only tighten', bad === 0, firstBad);
  const base = (key, deps, extra = {}) => ({ ...mk(key, deps), approvalPolicy: { beforeStart: false, onCompletion: false }, completionGate: null, ...extra });
  const two = { summary: 's', tasks: [base('implement', []), { ...base('ship', ['implement']), executor: 'ship', roleId: 'ship' }] };
  const authCtx = D.profileRuleContext({ type: 'fix', size: 'xs', risk: 'high', areas: [{ name: 'auth', sensitivity: 'critical' }], repos: [], signals: [], source: 'rules', basis: 'predicted' });
  const sec = D.applyModules(two, cfg.modules, authCtx.facts, authCtx.predicates);
  const ship = sec.plan.tasks.find((t) => t.key === 'ship');
  check('security-review goes between implement and ship', eq(sec.plan.tasks.map((t) => t.key), ['implement', 'security_review', 'ship']) && ship.dependsOn.includes('security_review') && sec.applied.includes('security-review'), sec.plan.tasks.map((t) => [t.key, t.dependsOn]));
  check('a module naming a missing step is dropped with why', D.applyModules({ summary: 's', tasks: [base('fix', [])] }, cfg.modules, authCtx.facts, authCtx.predicates).dropped[0]?.why === "this plan has no 'implement' step");
  const twoShips = D.compileWorkflow({ name: 'w', inputs: [], steps: [
    { key: 'a', objective: 'x', role: 'development', executor: 'agent', dependsOn: [], capabilities: [], outputs: [], inputs: [], approval: 'none' },
    { key: 'ship', objective: 'x', executor: 'ship', dependsOn: ['a'], capabilities: [], outputs: [], inputs: [], approval: 'none' },
    { key: 'ship_again', objective: 'x', executor: 'ship', dependsOn: ['a'], capabilities: [], outputs: [], inputs: [], approval: 'none' },
  ] }, {});
  check('two ship steps do not compile', !twoShips.ok && twoShips.error.some((i) => i.message === "A workflow has at most one ship step; 'ship_again' is the second."), twoShips);
  const oneShip = D.compileWorkflow({ name: 'w', inputs: [], steps: [
    { key: 'a', objective: 'x', role: 'development', executor: 'agent', dependsOn: [], capabilities: [], outputs: [], inputs: [], approval: 'none' },
    { key: 'ship', objective: 'x', executor: 'ship', dependsOn: ['a'], capabilities: [], outputs: [], inputs: [], approval: 'none' },
  ] }, {});
  const shipTask = oneShip.ok ? oneShip.value.tasks[1] : null;
  check('a ship step compiles with no role', shipTask?.roleId === 'ship' && shipTask.executionPolicy.isolation === 'none' && shipTask.retryPolicy.maxAttempts === 1 && shipTask.stepClass === 'ship', shipTask ?? oneShip);
  const routed = D.resolveModel({ step: { model: 'sonnet', reason: 'routed: sonnet passed 23 of 25' }, role: null, profileModel: null, attempt: 1, pressure: null, runtimeTakesModel: true });
  check('a routed model carries its reason', routed.reason === 'routed: sonnet passed 23 of 25' && routed.source === 'step', routed);
  check('a step model without a reason is still a step override', D.resolveModel({ step: { model: 'sonnet' }, role: null, profileModel: null, attempt: 1, pressure: null, runtimeTakesModel: true }).reason === 'step override');
  check('the implicit criterion is a source', D.CRITERION_SOURCES.includes('implicit') && D.IMPLICIT_CRITERION_KEY === 'I1');
});

// @sections

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
