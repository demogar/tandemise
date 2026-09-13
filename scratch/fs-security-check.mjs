/**
 * Regression suite for filesystem containment (MVP.md §19.2).
 *
 * Every case here corresponds to a way an earlier implementation could be made
 * to write outside a worker's declared roots. The threat model is a worker that
 * may be prompt-injected or compromised and that can freely create files -
 * including symlinks - inside its own worktree.
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScopedFileSystem } from '@tandemise/execution-core';

let pass = 0; const fails = [];
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}${d ? `  ${d}` : ''}`); } else { fails.push(n); console.log(`  FAIL ${n}${d ? `  ${d}` : ''}`); } };

const denies = async (name, fn) => {
  try { await fn(); ok(name, false, 'NOT denied'); }
  catch (e) { ok(name, e?.code === 'PERMISSION_DENIED', e?.code === 'PERMISSION_DENIED' ? '' : `wrong error: ${e?.code ?? e}`); }
};
const allows = async (name, fn) => {
  try { await fn(); ok(name, true); }
  catch (e) { ok(name, false, `denied: ${e?.message ?? e}`); }
};

const base = mkdtempSync(join(tmpdir(), 'tdm-fssec-'));
const outside = join(base, 'OUTSIDE');
const wt = join(base, 'worktree');
mkdirSync(outside, { recursive: true });
mkdirSync(wt, { recursive: true });
writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n');
const fs_ = new ScopedFileSystem(wt);

console.log('── ordinary operation');
await allows('write inside the root', () => fs_.write('notes.md', 'hello'));
await allows('read it back', async () => { if ((await fs_.read('notes.md')) !== 'hello') throw new Error('bad content'); });
await allows('write into a nested new directory', () => fs_.write('a/b/c/deep.txt', 'deep'));
ok('nested file landed inside the root', existsSync(join(wt, 'a/b/c/deep.txt')));
await allows('a symlink that stays inside is followed', async () => {
  mkdirSync(join(wt, 'real'), { recursive: true });
  writeFileSync(join(wt, 'real/inner.txt'), 'inner');
  symlinkSync(join(wt, 'real'), join(wt, 'linked'));
  if ((await fs_.read('linked/inner.txt')) !== 'inner') throw new Error('bad content');
});

console.log('\n── lexical traversal');
await denies('../ escape is denied', () => fs_.write('../OUTSIDE/pwned.txt', 'x'));
await denies('deep ../ escape is denied', () => fs_.write('a/b/../../../OUTSIDE/pwned.txt', 'x'));
await denies('absolute path outside is denied', () => fs_.write(join(outside, 'pwned.txt'), 'x'));
await denies('a NUL byte is denied', () => fs_.read('notes\0.md'));

console.log('\n── symlink escapes (the class of bug this file exists for)');
symlinkSync(join(outside, 'secret.txt'), join(wt, 'link-to-existing'));
await denies('read through a link to an existing outside file', () => fs_.read('link-to-existing'));
await denies('write through a link to an existing outside file', () => fs_.write('link-to-existing', 'overwritten'));
ok('the outside file was not modified', readFileSync(join(outside, 'secret.txt'), 'utf8') === 'TOP SECRET\n');

// The original escape: realpath() fails on a dangling link, and a resolver that
// falls back to the lexical parent approves a path it never actually resolved.
symlinkSync(join(outside, 'does-not-exist-yet.txt'), join(wt, 'dangling'));
await denies('write through a DANGLING link pointing outside', () => fs_.write('dangling', 'pwned'));
ok('the dangling link target was never created', !existsSync(join(outside, 'does-not-exist-yet.txt')));

symlinkSync(outside, join(wt, 'dirlink'));
await denies('write through a link to an outside DIRECTORY', () => fs_.write('dirlink/pwned.txt', 'x'));
await denies('read through a link to an outside directory', () => fs_.read('dirlink/secret.txt'));
await denies('mkdir through a link to an outside directory', () => fs_.mkdir('dirlink/newdir'));
await denies('list through a link to an outside directory', () => fs_.list('dirlink'));
ok('nothing was created outside', !existsSync(join(outside, 'pwned.txt')) && !existsSync(join(outside, 'newdir')));

symlinkSync(join(wt, 'dirlink'), join(wt, 'link-to-link'));
await denies('a link chain to outside is denied', () => fs_.write('link-to-link/pwned.txt', 'x'));

symlinkSync(join(wt, 'loop-b'), join(wt, 'loop-a'));
symlinkSync(join(wt, 'loop-a'), join(wt, 'loop-b'));
await denies('a symlink cycle is denied rather than hanging', () => fs_.read('loop-a'));

console.log('\n── root spelling (macOS /tmp is itself a symlink)');
// Elsewhere /tmp is a real directory, so reach the root through a symlink instead.
const aliasDir = mkdtempSync(join(tmpdir(), 'tdm-fssec-alias-'));
if (realpathSync(base) === base) symlinkSync(base, join(aliasDir, 'root'));
const given = realpathSync(base) === base ? join(aliasDir, 'root') : base;
const canonical = realpathSync(base);
ok('the two spellings really do differ', given !== canonical, `${given} vs ${canonical}`);
const byGiven = new ScopedFileSystem(join(given, 'worktree'));
const byCanonical = new ScopedFileSystem(join(canonical, 'worktree'));
await allows('root given as /tmp accepts a /tmp path', () => byGiven.read('notes.md'));
await allows('root given as /tmp accepts a /private/tmp path', () => byGiven.read(join(canonical, 'worktree', 'notes.md')));
await allows('root given as /private/tmp accepts a /tmp path', () => byCanonical.read(join(given, 'worktree', 'notes.md')));
await allows('root given as /private/tmp accepts a /private/tmp path', () => byCanonical.read('notes.md'));

console.log('\n── extra roots');
const shared = join(base, 'shared');
mkdirSync(shared, { recursive: true });
writeFileSync(join(shared, 'ok.txt'), 'shared');
const multi = new ScopedFileSystem(wt, [shared]);
await allows('a declared extra root is reachable', () => multi.read(join(shared, 'ok.txt')));
await denies('an undeclared sibling is still denied', () => multi.read(join(outside, 'secret.txt')));

console.log(`\n${'─'.repeat(58)}`);
console.log(fails.length === 0 ? `ALL ${pass} FILESYSTEM SECURITY CHECKS PASSED` : `${pass} passed, ${fails.length} FAILED:\n  - ${fails.join('\n  - ')}`);
process.exit(fails.length === 0 ? 0 : 1);
