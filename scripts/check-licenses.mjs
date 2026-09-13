// Fails if any installed third-party package carries a license that is not on
// the allowlist below. Tandemise is Apache-2.0, so copyleft (GPL, LGPL, AGPL,
// MPL, EUPL, SSPL...) or unlicensed code must not slip in through a dependency.
//
// Reads package-lock.json, so it needs no install. An SPDX `OR` expression passes
// when any of its options is allowed; `AND` needs every part allowed.
import { readFileSync } from 'node:fs';

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'Unlicense',
  'CC0-1.0',
  'Python-2.0',
  'WTFPL',
]);

/** Data-only packages allowed under a license that would not fit code. */
const EXCEPTIONS = new Map([
  ['caniuse-lite', 'CC-BY-4.0'], // browser support data used by build tooling
]);

function allowed(expr) {
  const e = expr.trim().replace(/^\((.*)\)$/, '$1');
  if (e.includes(' OR ')) return e.split(' OR ').some(allowed);
  if (e.includes(' AND ')) return e.split(' AND ').every(allowed);
  return ALLOWED.has(e);
}

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const problems = [];
let count = 0;
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.includes('node_modules/') || entry.link) continue;
  count++;
  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const license = typeof entry.license === 'string' ? entry.license : undefined;
  if (license && (allowed(license) || EXCEPTIONS.get(name) === license)) continue;
  problems.push(`${name}@${entry.version}: ${license ?? 'no license declared'}${entry.dev ? ' (dev)' : ''}`);
}

if (problems.length) {
  console.error(`✗ ${problems.length} package(s) with a license not allowed for an Apache-2.0 project:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ licenses ok (${count} packages)`);
