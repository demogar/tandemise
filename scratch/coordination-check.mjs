// The optional relay's shared pieces: the wire contract, the coordination
// schema and rules, the store, the mailbox and the local mode
// (docs/superpowers/specs/2026-10-30-relay-design.md).
//
//   npm run build && node scratch/coordination-check.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);

const R = await import('../packages/api-contract/dist/relay.js');

section('contract');
{
  check('RELAY_API_VERSION is 1', R.RELAY_API_VERSION === '1');
  check('the relay api header', R.RELAY_API_HEADER === 'x-tandemise-relay-api');
  check('a pull of 51 is refused', R.mailboxPullRequest.safeParse({ project: 'p', max: 51, leaseSeconds: 10 }).success === false);
  check('a pull of 50 passes', R.mailboxPullRequest.safeParse({ project: 'p', max: 50, leaseSeconds: 10 }).success === true);
  check('a watch frame parses', R.relayClientFrame.safeParse({ type: 'watch', projects: ['a'] }).success === true);
  check('a chat frame does not', R.relayClientFrame.safeParse({ type: 'chat' }).success === false);
  check('an invite for 31 days is refused', R.createInviteRequest.safeParse({ role: 'member', displayName: 'Bo', expiresInDays: 31 }).success === false);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
