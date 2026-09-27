// Runs the offline end-to-end checks in `scratch/` - the ones that need no model
// login, no network service, no browser and no macOS permission - one after
// another, and fails if any of them fails. This is what CI runs after the build.
//
// Checks that drive a real runtime (Claude, Codex, Gemini), Electron, Playwright,
// the macOS helper, a real `claude` binary or the Taskly demo app checkout
// (application-check) are left out on purpose; run those by hand (docs/QUICKSTART.md).
//
//   node scripts/run-checks.mjs              # every offline check
//   node scripts/run-checks.mjs resume-check # just the named ones
import { spawn } from 'node:child_process';

export const OFFLINE_CHECKS = [
  'artifact-lineage-check',
  'artifact-write-scope-check',
  'concurrency-check',
  'env-leak-check',
  'execution-check',
  'feedback-loop-check',
  'fs-security-check',
  'gate-facts-check',
  'handoff-check',
  'mcp-integration-check',
  'multirepo-check',
  'p5-done-when-check',
  'p6-ready-check',
  'p7-backlog-check',
  'p8-limits-check',
  'p9-liveness-check',
  'p10-desk-check',
  'p11-routines-check',
  'p12-models-check',
  'p16-notify-check',
  'oauth-connect-check',
  'persistence-check',
  'planner-steps-check',
  'policy-eval-check',
  'resume-check',
  'review-sees-diff-check',
  'routing-overcommit-check',
  'rounds-check',
  'schema-constraint-check',
  'secrets-check',
  'shell-benign-check',
  'signin-check',
  'staffing-check',
  'trust-boundary-check',
  'workflow-check',
];

const TIMEOUT_MS = 5 * 60_000;

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [`scratch/${name}.mjs`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ name, ok: code === 0, code: signal ?? code, output, ms: Date.now() - started });
    });
  });
}

const selected = process.argv.slice(2);
const unknown = selected.filter((n) => !OFFLINE_CHECKS.includes(n));
if (unknown.length) {
  console.error(`not an offline check: ${unknown.join(', ')}`);
  process.exit(2);
}

const failed = [];
for (const name of selected.length ? selected : OFFLINE_CHECKS) {
  const result = await run(name);
  console.log(`${result.ok ? '✓' : '✗'} ${name} (${(result.ms / 1000).toFixed(1)}s)`);
  if (!result.ok) {
    failed.push(name);
    console.log(`--- ${name} exited ${result.code} ---\n${result.output}\n--- end ${name} ---`);
  }
}

if (failed.length) {
  console.error(`\n${failed.length} check(s) failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('\nall offline checks passed');
