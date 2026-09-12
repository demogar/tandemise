/**
 * The other half of shell classification: ordinary developer commands must NOT
 * escalate. A classifier that flags everything is as useless as one that flags
 * nothing — it just fails in the direction that trains the user to click
 * "approve" without reading.
 */
import { classifyShellCommand, createPolicyEngine } from '/Users/you/projects/tandemise/packages/policy/dist/index.js';

const ctx = { writableRoots: ['/wt'], cwd: '/wt' };
let bad = 0;
const benign = [
  'npm test', 'npm run build', 'npm ci', 'npx tsc -b',
  'rm -rf node_modules', 'rm -rf /wt/dist', 'rm /wt/tmp/file.txt',
  'git status', 'git diff', 'git add -A', 'git commit -m "fix: thing"',
  'git checkout -b feature/x', 'git log --oneline', 'git worktree list',
  'git merge --no-ff feature/x',
  'mkdir -p /wt/src/components', 'cp /wt/a.txt /wt/b.txt', 'mv /wt/a.txt /wt/b.txt',
  'echo "hello" > /wt/out.txt', 'cat /wt/package.json', 'ls -la',
  'node --test test/', 'pytest -q', 'make build',
  'grep -rn "TODO" /wt/src', 'sed -i "" "s/a/b/" /wt/src/x.ts',
  'tee /wt/log.txt', 'curl -s https://api.example.com/health',
  'FOO=bar npm run dev', 'cd /wt && npm test',
];

// Publishing to a remote is genuinely an external side effect (MVP.md §18.2),
// not a destructive one. It is expected to escalate exactly one step.
const externalSideEffect = ['git push origin feature/x', 'gh pr create --draft'];

console.log('── benign developer commands must not escalate\n');
for (const cmd of benign) {
  const { risk, reason } = classifyShellCommand(cmd, ctx);
  const okay = risk === 'read' || risk === 'write_reversible';
  if (!okay) { bad++; console.log(`  FALSE POSITIVE  ${risk.padEnd(20)} ${JSON.stringify(cmd)}  (${reason})`); }
  else console.log(`  ok   ${risk.padEnd(18)} ${JSON.stringify(cmd)}`);
}
console.log('\n── external side effects escalate exactly one step, not to destructive\n');
for (const cmd of externalSideEffect) {
  const { risk, reason } = classifyShellCommand(cmd, ctx);
  const okay = risk === 'external_side_effect';
  if (!okay) { bad++; console.log(`  WRONG  ${risk.padEnd(20)} ${JSON.stringify(cmd)}  (${reason})`); }
  else console.log(`  ok   ${risk.padEnd(18)} ${JSON.stringify(cmd)}`);
}

console.log(`\n${bad === 0 ? `ALL ${benign.length + externalSideEffect.length} COMMANDS CLASSIFIED CORRECTLY` : `${bad} FALSE POSITIVES`}`);

// --- externalWrites: 'policy' is gated on plan approval (MVP.md §18.2) -------
const engine = createPolicyEngine();
const autonomy = { planApproval: 'ask', localCodeChanges: 'auto', externalWrites: 'policy', productionRelease: 'ask', financialActions: 'deny' };
const grants = [{ capability: 'github.pr.create', resourceScope: ['acme/app'], approvalMode: 'auto', expiresAt: null }];
const base = { capability: 'github.pr.create', resource: 'acme/app', grants, autonomy };

console.log('\n── externalWrites "policy" means "after plan approval"\n');
const before = engine.evaluate(base);
const after = engine.evaluate({ ...base, planApproved: true });
let g = 0;
if (before.outcome !== 'require_approval') { g++; console.log(`  FAIL  before plan approval -> ${before.outcome} (expected require_approval)`); }
else console.log(`  ok   before plan approval -> require_approval  ${before.reason}`);
if (after.outcome !== 'allow') { g++; console.log(`  FAIL  after plan approval -> ${after.outcome} (expected allow)`); }
else console.log(`  ok   after plan approval -> allow  ${after.reason}`);
const denied = engine.evaluate({ ...base, autonomy: { ...autonomy, externalWrites: 'deny' }, planApproved: true });
if (denied.outcome !== 'deny') { g++; console.log(`  FAIL  externalWrites "deny" -> ${denied.outcome}`); }
else console.log(`  ok   externalWrites "deny" still denies even with an approved plan`);
console.log(g === 0 ? '\nPLAN-APPROVAL GATING OK' : `\n${g} PLAN-APPROVAL FAILURES`);
process.exit(bad + g === 0 ? 0 : 1);
