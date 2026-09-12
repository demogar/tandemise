/**
 * A workflow someone wrote, end to end.
 *
 * The point of this file existing at all is that a process is specific: which
 * gates, who approves what, and where a person has to go and do something by
 * hand. So the check drives a real workflow file — Beveloce's `build-feature`,
 * with its human design step — through the real loader, compiler and validator.
 */
import { mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
};

const { compileWorkflow, parseWorkflowDefinition, validateMissionPlan } =
  await import('../packages/domain/dist/index.js');
const { FileWorkflowSource } = await import('../apps/daemon/dist/workflow-source.js');
const { materializePlan } = await import('../packages/application/dist/planning/materialize.js');
const { nullLogger } = await import('../packages/shared/dist/index.js');

// A repository that carries its own process, which is the whole idea.
const repo = mkdtempSync(join(tmpdir(), 'tandemise-wf-'));
mkdirSync(join(repo, '.tandemise', 'workflows'), { recursive: true });
copyFileSync('docs/examples/build-feature.yaml', join(repo, '.tandemise/workflows/build-feature.yaml'));

console.log('── found in the repository');
const source = new FileWorkflowSource(nullLogger);
const found = await source.list([repo, '/does/not/exist']);
ok('a missing repository is not an error', Array.isArray(found));
const wf = found.find((w) => w.id === 'build-feature');
ok('the workflow is discovered by filename', wf !== undefined, wf?.path ?? 'not found');
ok('it parsed', wf?.definition !== null, JSON.stringify(wf?.issues ?? []));
ok('its inputs are declared', wf?.definition?.inputs.some((i) => i.name === 'issue'));

console.log('\n── compiled with an input');
const compiled = compileWorkflow(wf.definition, { issue: '42' });
ok('compiles', compiled.ok, compiled.ok ? '' : JSON.stringify(compiled.error));
const tasks = compiled.value.tasks;
ok('every step became a task', tasks.length === wf.definition.steps.length, `${tasks.length} tasks`);
ok('the input was substituted', tasks[0].objective.includes('#42') && !tasks[0].objective.includes('{{'),
  tasks[0].objective.split('\n')[0]);
const design = tasks.find((t) => t.key === 'design');
ok('the design step is a human step', design.executor === 'human');
ok('a human step asks for no isolation', design.executionPolicy.isolation === 'none');
ok('a human step is not retried', design.retryPolicy.maxAttempts === 1);
ok('a human step still produces an artifact', design.expectedOutputs.includes('DesignBrief'));
const build = tasks.find((t) => t.key === 'build');
ok('the build waits on the human step', build.dependsOn.includes('design'));
ok('the gate came through verbatim', build.completionGate === 'checks.typecheck != FAIL && checks.lint != FAIL && checks.test != FAIL');
ok('an approval-before step is marked', tasks.find((t) => t.key === 'open_pr').approvalPolicy.beforeStart === true);

console.log('\n── it is a plan like any other');
const validated = validateMissionPlan(compiled.value, {
  // Deliberately only the real role templates: `human` and `wait` are not
  // roles, and a workflow using them must still validate.
  knownRoleIds: new Set(['product', 'architecture', 'development', 'review', 'release', 'qa']),
  satisfiableCapabilities: new Set(compiled.value.tasks.flatMap((t) => t.requiredCapabilities)),
});
ok('passes the ordinary plan validator', validated.ok,
  validated.ok ? '' : validated.error.filter((i) => i.severity === 'error').map((i) => i.message).join('; '));
const materialized = materializePlan(compiled.value, 'm1', { now: () => '2026-09-12T00:00:00.000Z' }, []);
ok('materializes into tasks the scheduler runs', materialized.length === tasks.length);
ok('the executor survives materialization',
  materialized.find((t) => t.key === 'design').executor === 'human'
  && materialized.find((t) => t.key === 'build').executor === 'agent');

console.log('\n── waiting on the world outside');
const ci = tasks.find((t) => t.key === 'ci');
ok('a wait step is its own executor', ci.executor === 'wait');
ok('it carries the command verbatim', ci.waitPolicy.command === 'gh pr checks --watch --fail-fast', ci.waitPolicy.command);
ok('it has an interval and a deadline', ci.waitPolicy.everyMs === 30000 && ci.waitPolicy.timeoutMs === 1800000);
ok('a wait is never retried', ci.retryPolicy.maxAttempts === 1);
ok('a wait needs no role', ci.roleId === 'wait');
ok('the merge waits for CI', tasks.find((t) => t.key === 'merge').dependsOn.includes('ci'));
ok('the whole lifecycle is one graph',
  ['read_issue', 'design', 'build', 'review', 'open_pr', 'ci', 'merge', 'deployed', 'smoke', 'docs']
    .every((k) => tasks.some((t) => t.key === k)), `${tasks.length} steps`);

// The waiter itself: no model, one command, an exit code.
{
  const { Waiter } = await import('../packages/application/dist/engine/waiter.js');
  const { nullLogger: log } = await import('../packages/shared/dist/index.js');
  let calls = 0;
  const waiter = new Waiter({
    exec: () => ({ run: async () => ({ exitCode: ++calls < 3 ? 1 : 0, stdout: 'all checks passed', stderr: '', timedOut: false, durationMs: 1, command: 'x' }) }),
    clock: { now: () => new Date().toISOString(), epochMs: () => Date.now() },
    log,
  });
  const outcome = await waiter.wait({ id: 't1' }, { command: 'x', everyMs: 5, timeoutMs: 5000 }, null, new AbortController().signal);
  ok('a wait polls until the command succeeds', outcome.kind === 'passed' && outcome.polls === 3,
    `${outcome.kind} after ${outcome.polls} polls`);
  ok('it reports what the command said', outcome.detail === 'all checks passed', outcome.detail);

  const never = new Waiter({
    exec: () => ({ run: async () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false, durationMs: 1, command: 'x' }) }),
    clock: { now: () => new Date().toISOString(), epochMs: () => Date.now() }, log,
  });
  const timedOut = await never.wait({ id: 't2' }, { command: 'x', everyMs: 5, timeoutMs: 60 }, null, new AbortController().signal);
  ok('it gives up at the deadline rather than forever', timedOut.kind === 'timedOut', timedOut.detail);

  const controller = new AbortController();
  const cancelling = never.wait({ id: 't3' }, { command: 'x', everyMs: 50, timeoutMs: 60_000 }, null, controller.signal);
  setTimeout(() => controller.abort(), 30);
  ok('stopping the mission stops the wait', (await cancelling).kind === 'cancelled');
}

console.log('\n── authoring mistakes are caught, not guessed at');
const missingInput = compileWorkflow(wf.definition, {});
ok('a missing required input is refused', !missingInput.ok,
  missingInput.ok ? 'accepted' : missingInput.error[0].message);

const badDep = parseWorkflowDefinition({
  name: 'x',
  steps: [{ key: 'a', objective: 'o', role: 'product', dependsOn: ['desgin'] }],
});
const badCompiled = compileWorkflow(badDep.value, {});
ok('a typo in dependsOn names the step and the typo', !badCompiled.ok
  && badCompiled.error[0].message.includes("'desgin'"), badCompiled.ok ? 'accepted' : badCompiled.error[0].message);

const agentNoRole = compileWorkflow(parseWorkflowDefinition({
  name: 'x', steps: [{ key: 'a', objective: 'o' }],
}).value, {});
ok('an agent step with no role is refused', !agentNoRole.ok, agentNoRole.ok ? 'accepted' : agentNoRole.error[0].message);

const unknownTemplate = compileWorkflow(parseWorkflowDefinition({
  name: 'x', steps: [{ key: 'a', objective: 'see {{ ticket }}', role: 'product' }],
}).value, {});
ok('an undeclared {{ placeholder }} is refused', !unknownTemplate.ok,
  unknownTemplate.ok ? 'accepted' : unknownTemplate.error[0].message);

const waitNoCommand = compileWorkflow(parseWorkflowDefinition({
  name: 'x', steps: [{ key: 'a', objective: 'o', executor: 'wait' }],
}).value, {});
ok('a wait step with nothing to wait for is refused', !waitNoCommand.ok,
  waitNoCommand.ok ? 'accepted' : waitNoCommand.error[0].message);

const strayWaitFor = compileWorkflow(parseWorkflowDefinition({
  name: 'x', steps: [{ key: 'a', objective: 'o', role: 'product', waitFor: 'true' }],
}).value, {});
ok('waitFor on a non-wait step is refused', !strayWaitFor.ok,
  strayWaitFor.ok ? 'accepted' : strayWaitFor.error[0].message);

rmSync(repo, { recursive: true, force: true });
console.log('\n' + '─'.repeat(60));
console.log(failures.length === 0
  ? `ALL ${passed} WORKFLOW CHECKS PASSED`
  : `${passed} passed, ${failures.length} FAILED:\n  - ${failures.join('\n  - ')}`);
process.exit(failures.length === 0 ? 0 : 1);
