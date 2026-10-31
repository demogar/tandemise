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

// @sections

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
