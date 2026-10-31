// The PTY host behind held tasks
// (docs/superpowers/specs/2026-10-30-hold-and-interact-design.md).
//
//   npm run build && node scratch/terminal-check.mjs
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const T = await import('@tandemise/terminal');
const { FakeRuntimeAdapter } = await import('@tandemise/runtime-generic');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const until = async (cond, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return cond();
};

section('scrollback ring');
{
  const s = new T.Scrollback(1024 * 1024);
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  for (let i = 0; i < 32; i++) s.push(chunk); // 2 MiB
  check('never exceeds 1 MiB after 2 MiB written', s.size === 1024 * 1024 && s.snapshot().length === 1024 * 1024, s.size);
  s.push(Buffer.from('tail'));
  check('keeps the newest bytes', s.snapshot().subarray(-4).toString() === 'tail' && s.size === 1024 * 1024);
}

section('pty host');
{
  const dir = mkdtempSync(join(tmpdir(), 'tandemise-terminal-'));
  const host = new T.PtyHost();
  const avail = host.available();
  check('node-pty loads', avail.ok === true, avail);
  if (avail.ok) {
    const inv = new FakeRuntimeAdapter().interactive(null, { workingDirectory: dir }, { sessionFile: join(dir, 'session'), initialPrompt: null });
    const exits = [];
    host.onExit((id, code) => exits.push([id, code]));
    const a = [];
    const opened = host.open('hold-1', inv);
    check('open returns a pid', Number.isInteger(opened.pid) && opened.pid > 0);
    check('isOpen after open', host.isOpen('hold-1'));
    const detachA = host.attach('hold-1', { data: (b) => a.push(b), exit: () => {} });
    check('data arrives at an attached sink', await until(() => Buffer.concat(a).toString().includes('Fake session')), Buffer.concat(a).toString());

    host.write('hold-1', 'hello\r');
    await until(() => Buffer.concat(a).toString().includes('> hello'));
    const b = [];
    const detachB = host.attach('hold-1', { data: (x) => b.push(x), exit: () => {} });
    check('a later sink gets the scrollback replayed first', Buffer.concat(b).toString().includes('> hello'), Buffer.concat(b).toString());
    detachA();
    check('detaching a sink keeps the pty open', host.isOpen('hold-1') === true);

    host.write('hold-1', 'write b.txt\r');
    check('write reaches the process', await until(() => existsSync(join(dir, 'b.txt'))));
    let threw = false;
    try { host.resize('hold-1', 100, 30); } catch { threw = true; }
    check('resize does not throw', !threw);

    await host.end('hold-1', 1000);
    check('end resolves and closes the session', !host.isOpen('hold-1'));
    check('onExit fires with the hold id', exits.some(([id]) => id === 'hold-1'), exits);
    detachB();
    check('write to a closed session is a no-op', (() => { try { host.write('hold-1', 'x'); return true; } catch { return false; } })());
  }
  rmSync(dir, { recursive: true, force: true });
}

section('fan-out: one throwing listener does not stop the others');
{
  const host = new T.PtyHost();
  const dir = mkdtempSync(join(tmpdir(), 'tandemise-terminal-fan-'));
  const exits = [];
  host.onExit(() => { throw new Error('listener boom'); });
  host.onExit((id, code) => exits.push([id, code]));
  host.open('hold-fan', {
    file: process.execPath,
    args: ['-e', "process.stdout.write('READY-FAN\\n'); process.stdin.on('data', (d) => { if (String(d).includes('go')) { process.stdout.write('AFTER-FAN\\n'); setTimeout(() => process.exit(0), 50); } })"],
    env: {}, cwd: dir, sessionFile: join(dir, 's'),
  });
  const good = [];
  let goodExit;
  let thrown = 0;
  host.attach('hold-fan', { data: () => { thrown++; throw new Error('sink boom'); }, exit: () => { throw new Error('sink exit boom'); } });
  host.attach('hold-fan', { data: (b) => good.push(b), exit: (code) => { goodExit = code; } });
  await until(() => Buffer.concat(good).toString().includes('READY-FAN'));
  host.write('hold-fan', 'go\r');
  const arrived = await until(() => Buffer.concat(good).toString().includes('AFTER-FAN'));
  check('data still reaches a sink after one before it threw', arrived && thrown > 0, Buffer.concat(good).toString());
  await until(() => !host.isOpen('hold-fan'));
  check('exit still reaches the other sink and the later exit listener', goodExit === 0 && exits.some(([id]) => id === 'hold-fan'), { goodExit, exits });
  rmSync(dir, { recursive: true, force: true });
}

section('end: /exit, then EOF, before any signal');
{
  const host = new T.PtyHost();
  const dir = mkdtempSync(join(tmpdir(), 'tandemise-terminal-eof-'));
  // Deaf to `/exit` and to SIGTERM: only EOF (or SIGKILL) ends it.
  host.open('hold-eof', {
    file: process.execPath,
    args: ['-e', "process.on('SIGTERM', () => {}); process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(7)); process.stdout.write('READY-EOF\\n')"],
    env: {}, cwd: dir, sessionFile: join(dir, 's'),
  });
  const out = [];
  let code;
  host.attach('hold-eof', { data: (b) => out.push(b), exit: (c) => { code = c; } });
  await until(() => Buffer.concat(out).toString().includes('READY-EOF'));
  const t0 = Date.now();
  await host.end('hold-eof', 1500);
  const took = Date.now() - t0;
  check('a session that only answers EOF ends on it, within the first grace', code === 7 && took < 1500, { code, took });
  rmSync(dir, { recursive: true, force: true });
}

section('environment: only the invocation env reaches the child');
{
  process.env.TANDEMISE_POISON = '1';
  const host = new T.PtyHost();
  const dir = mkdtempSync(join(tmpdir(), 'tandemise-terminal-env-'));
  const out = [];
  host.open('hold-env', {
    file: process.execPath,
    args: ['-e', "console.log('ENV:' + JSON.stringify(Object.keys(process.env)))"],
    env: { TANDEMISE_MARKER: '1' },
    cwd: dir,
    sessionFile: join(dir, 's'),
  });
  host.attach('hold-env', { data: (b) => out.push(b), exit: () => {} });
  await until(() => Buffer.concat(out).toString().includes('ENV:'));
  const text = Buffer.concat(out).toString();
  check('the invocation env reaches the child', text.includes('TANDEMISE_MARKER'), text);
  check('the daemon env does not', !text.includes('TANDEMISE_POISON'), text);
  await host.end('hold-env', 500);
  delete process.env.TANDEMISE_POISON;
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.join('\n')); process.exit(1); }
