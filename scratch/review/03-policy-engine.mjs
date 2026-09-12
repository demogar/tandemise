// FINDING 5: risk classification is silently skipped when `shell` context is absent,
// so a destructive command is auto-allowed.
// FINDING 6: an unparseable/garbage `expiresAt` fails OPEN (grant treated as live).
import { createRiskClassifier } from '../../packages/policy/dist/risk.js';
import { createPolicyEngine } from '../../packages/policy/dist/engine.js';

const autonomy = {
  localCodeChanges: 'auto',
  externalWrites: 'policy',
  productionRelease: 'ask',
};

const classifier = createRiskClassifier();
const DANGER = 'sudo rm -rf /Users/demo/Documents';

console.log('--- risk classifier ---');
console.log('with shell ctx   :', classifier.classify({
  capability: 'shell.exec',
  command: DANGER,
  shell: { writableRoots: ['/wt'], cwd: '/wt' },
}).risk);
console.log('WITHOUT shell ctx:', classifier.classify({
  capability: 'shell.exec',
  command: DANGER,
}).risk, ' <-- command ignored entirely');

const engine = createPolicyEngine();
const grants = [{
  capability: 'shell.exec',
  resourceScope: ['/wt'],
  approvalMode: 'auto',
  expiresAt: null,
  reason: 'dev',
}];

console.log('\n--- policy engine ---');
for (const shell of [{ writableRoots: ['/wt'], cwd: '/wt' }, undefined]) {
  const d = engine.evaluate({
    capability: 'shell.exec',
    resource: '/wt',
    command: DANGER,
    ...(shell ? { shell } : {}),
    grants,
    autonomy,
  });
  console.log(`shell ctx ${shell ? 'present' : 'absent '} -> ${d.outcome.padEnd(17)} risk=${d.risk}`);
}

console.log('\n--- expiry parsing ---');
const now = { now: () => '2026-09-11T00:00:00.000Z', epochMs: () => Date.parse('2026-09-11T00:00:00.000Z') };
for (const expiresAt of ['2020-01-01T00:00:00.000Z', 'not-a-date', '']) {
  const e = createPolicyEngine({ clock: now });
  const d = e.evaluate({
    capability: 'filesystem.read',
    resource: '/wt/a.txt',
    grants: [{ capability: 'filesystem.read', resourceScope: ['/wt'], approvalMode: 'auto', expiresAt, reason: 'x' }],
    autonomy,
  });
  console.log(`expiresAt=${JSON.stringify(expiresAt).padEnd(28)} -> ${d.outcome}`);
}

console.log('\n--- autonomy.externalWrites === "policy" ---');
const d = createPolicyEngine().evaluate({
  capability: 'github.pr.create',
  resource: 'acme/app',
  grants: [{ capability: 'github', resourceScope: ['acme/app'], approvalMode: 'auto', expiresAt: null, reason: 'x' }],
  autonomy: { localCodeChanges: 'auto', externalWrites: 'policy', productionRelease: 'ask' },
});
console.log('github.pr.create ->', d.outcome, '|', d.reason);
