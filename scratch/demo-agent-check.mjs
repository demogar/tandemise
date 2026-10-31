/**
 * The docs-screenshots demo agent is the acceptance suite's scripted agent with
 * its strings swapped (scratch/docs-screenshots/make-demo-agent.mjs), by exact
 * text. When the scripted agent changed ("missing: points", #85) the seed broke
 * silently. This check builds the demo agent and fails if any swap misses, if the
 * result is not valid JavaScript, or if a scripted/hello-page string survives.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'demo-agent-'));
const out = join(dir, 'demo-agent.mjs');
let bad = 0;
const ok = (n, c, d = '') => { if (c) console.log(`  ok   ${n}`); else { bad++; console.log(`  FAIL ${n}  ${d}`); } };
try {
  try {
    execFileSync(process.execPath, [join(root, 'scratch/docs-screenshots/make-demo-agent.mjs'), out], { stdio: 'pipe' });
    ok("the demo agent builds from today's scripted agent", true);
  } catch (e) {
    ok("the demo agent builds from today's scripted agent", false, String(e.stderr).split('\n').find((l) => l.includes('Error')) ?? e.message);
  }
  try {
    execFileSync(process.execPath, ['--check', out], { stdio: 'pipe' });
    ok('it is valid JavaScript', true);
    const s = readFileSync(out, 'utf8');
    const at = s.indexOf('const handoff = {');
    const handoff = s.slice(at, at + 900);
    ok('the handoff says nothing scripted', at >= 0 && !/hello page|No model was called/i.test(handoff), handoff);
  } catch (e) {
    ok('it is valid JavaScript', false, e.message);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
process.exit(bad ? 1 : 0);
