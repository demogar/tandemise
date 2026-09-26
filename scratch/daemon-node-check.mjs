// Which Node the desktop starts the daemon with.
//
// The desktop used to start the daemon with Electron's bundled Node, which has a
// different native ABI from the Node that compiled better-sqlite3, so Retry on
// the "daemon is not running" screen always ended in "Cannot open database".
// `resolveDaemonNode` (apps/desktop/src/main/node-runtime.ts) now picks the Node;
// it is pure, so it is driven here with a fake filesystem and fake versions.
// Then the real thing: the daemon started with Electron's Node still fails (so
// the premise holds), and started with the Node the resolver picks on this
// machine it opens its database.
//
//   npm run build && node scratch/daemon-node-check.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const require = createRequire(import.meta.url);
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 700)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);

// The module lives in the desktop's main process, which electron-vite bundles;
// it has no runtime imports, so transpiling the one file is enough.
const ts = require('typescript');
const source = readFileSync(join(root, 'apps/desktop/src/main/node-runtime.ts'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { resolveDaemonNode, parseLoginShellPath, LOGIN_PATH_MARKER, MIN_NODE_MAJOR } =
  await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

const ELECTRON = { execPath: '/Apps/Tandemise.app/Contents/MacOS/Tandemise', nodeVersion: '20.18.3' };
/** A fake machine: `bins` maps an executable path to its `--version` (null = crashes). */
const world = ({ env = {}, loginShellPath = null, bins = {}, electron = ELECTRON, platform = 'darwin' } = {}) => {
  const probed = [];
  return {
    probed,
    env, platform, loginShellPath, electron,
    isExecutable: (p) => Object.prototype.hasOwnProperty.call(bins, p),
    versionOf: (p) => { probed.push(p); return bins[p] ?? null; },
  };
};

section('the version floor matches the root package.json');
const engines = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).engines.node;
check(`MIN_NODE_MAJOR (${MIN_NODE_MAJOR}) is the engines floor (${engines})`, engines === `>=${MIN_NODE_MAJOR}.0.0`);

section('TANDEMISE_NODE wins, and a bad one is reported, not skipped');
{
  const r = resolveDaemonNode(world({
    env: { TANDEMISE_NODE: '/custom/node', PATH: '/usr/local/bin' },
    bins: { '/custom/node': 'v22.1.0', '/usr/local/bin/node': 'v24.0.0' },
  }));
  check('explicit path is used', r.ok && r.command === '/custom/node' && r.source === 'TANDEMISE_NODE' && r.version === '22.1.0', r);
  check('no ELECTRON_RUN_AS_NODE for a real node', r.ok && Object.keys(r.env).length === 0, r);
}
{
  const r = resolveDaemonNode(world({ env: { TANDEMISE_NODE: '/nope/node', PATH: '/usr/local/bin' }, bins: { '/usr/local/bin/node': 'v22.0.0' } }));
  check('missing TANDEMISE_NODE is an error naming it', !r.ok && r.message.includes('TANDEMISE_NODE is set to /nope/node') && r.message.includes('no runnable file'), r);
}
{
  const r = resolveDaemonNode(world({ env: { TANDEMISE_NODE: '/old/node' }, bins: { '/old/node': 'v18.19.0' } }));
  check('too-old TANDEMISE_NODE says its version and the floor', !r.ok && r.message.includes('Node 18.19.0') && r.message.includes('Node 22 or newer'), r);
}

section('the login shell PATH comes before the inherited one');
{
  // A Finder-launched app inherits launchd's PATH (/usr/bin:/bin:...); nvm lives only in the login shell's.
  const r = resolveDaemonNode(world({
    env: { PATH: '/usr/bin:/bin' },
    loginShellPath: '/Users/x/.nvm/versions/node/v22.11.0/bin:/usr/bin',
    bins: { '/Users/x/.nvm/versions/node/v22.11.0/bin/node': 'v22.11.0', '/usr/bin/node': 'v22.3.0' },
  }));
  check('picks the nvm node from the login shell', r.ok && r.command === '/Users/x/.nvm/versions/node/v22.11.0/bin/node' && r.source === 'PATH', r);
}
{
  const r = resolveDaemonNode(world({ env: { PATH: '/usr/bin:/bin' }, bins: { '/opt/homebrew/bin/node': 'v23.0.0' } }));
  check('falls back to the Homebrew directory when no PATH has node', r.ok && r.command === '/opt/homebrew/bin/node', r);
}
{
  const w = world({ env: { PATH: '/a:/a:/b' }, loginShellPath: '/a', bins: { '/a/node': 'v16.0.0', '/b/node': 'v22.0.0' } });
  const r = resolveDaemonNode(w);
  check('skips a too-old node and keeps looking', r.ok && r.command === '/b/node', r);
  check('each candidate is probed once', w.probed.filter((p) => p === '/a/node').length === 1, w.probed);
}
{
  const r = resolveDaemonNode(world({ env: { PATH: '/a' }, bins: { '/a/node': null, '/opt/homebrew/bin/node': 'v22.0.0' } }));
  check('a node that does not run is skipped', r.ok && r.command === '/opt/homebrew/bin/node', r);
}

section("Electron's Node is last, and only if it is new enough");
{
  const r = resolveDaemonNode(world({ env: { PATH: '' }, electron: { execPath: '/E', nodeVersion: '22.12.0' } }));
  check('a new-enough Electron Node is used with ELECTRON_RUN_AS_NODE', r.ok && r.source === 'electron' && r.command === '/E' && r.env.ELECTRON_RUN_AS_NODE === '1', r);
}
{
  const r = resolveDaemonNode(world({ env: { PATH: '/usr/local/bin' }, bins: { '/usr/local/bin/node': 'v22.0.0' }, electron: { execPath: '/E', nodeVersion: '22.12.0' } }));
  check('a real node beats Electron even when Electron would do', r.ok && r.source === 'PATH', r);
}

section('no usable Node: one plain message that says what to do');
{
  const r = resolveDaemonNode(world({ env: { PATH: '/usr/bin:/bin' } }));
  check('not ok', !r.ok, r);
  check('says what is missing', !r.ok && r.message.includes('needs Node.js 22 or newer') && r.message.includes('none was found'), r);
  check('says how to fix it', !r.ok && r.message.includes('brew install node') && r.message.includes('TANDEMISE_NODE') && r.message.includes('press Retry'), r);
  check("Electron's Node 20 is listed as rejected", !r.ok && r.tried.some((t) => t.source === 'electron' && /Node 20\.18\.3/.test(t.rejected)), r.tried);
  check('no stack, no newline', !r.ok && !/\n|at .*\(|Error:/.test(r.message), r.message);
}
{
  const r = resolveDaemonNode(world({ env: { PATH: '/usr/local/bin' }, bins: { '/usr/local/bin/node': 'v18.20.4' } }));
  check('a too-old node on PATH is named in the message', !r.ok && r.message.includes('Found Node 18.20.4 at /usr/local/bin/node, which is too old'), r);
}
{
  const r = resolveDaemonNode(world({
    env: { PATH: '/usr/local/bin', TANDEMISE_NODE_SEARCH_PATH: '' },
    loginShellPath: '/usr/local/bin',
    bins: { '/usr/local/bin/node': 'v22.0.0', '/opt/homebrew/bin/node': 'v22.0.0' },
  }));
  check('TANDEMISE_NODE_SEARCH_PATH="" simulates a machine with no node', !r.ok, r);
}

section('windows naming');
{
  const r = resolveDaemonNode(world({ platform: 'win32', env: { PATH: 'C:\\Node;C:\\Other' }, bins: { 'C:\\Node\\node.exe': 'v22.5.0' } }));
  check('node.exe on a ;-separated PATH', r.ok && r.command === 'C:\\Node\\node.exe', r);
}

section('reading PATH out of a login shell');
check('between markers, ignoring banners', parseLoginShellPath(`Welcome!\nnvm: using 22\n${LOGIN_PATH_MARKER}/a:/b${LOGIN_PATH_MARKER}\n`) === '/a:/b');
check('no markers -> null', parseLoginShellPath('zsh: command not found') === null);
check('empty -> null', parseLoginShellPath(`${LOGIN_PATH_MARKER}${LOGIN_PATH_MARKER}`) === null);

section('for real: Electron Node fails to open the database, the resolved Node does not');
const entry = join(root, 'apps/daemon/dist/main.js');
let electronPath = null;
try { electronPath = require(join(root, 'apps/desktop/node_modules/electron')); } catch {
  try { electronPath = require('electron'); } catch { /* not installed */ }
}
if (!existsSync(entry) || typeof electronPath !== 'string' || !existsSync(electronPath)) {
  console.log('  skip (no daemon build or no electron install)');
} else {
  // `better-sqlite3` is loaded exactly as the daemon loads it: the same file, the same ABI.
  const probe = "try{require('better-sqlite3')(':memory:').close();console.log('OPEN')}catch(e){console.log('FAIL '+String(e.message).replace(/\\s+/g,' '))}";
  const underElectron = spawnSync(electronPath, ['-e', probe], { cwd: root, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 });
  check("Electron's Node cannot load the SQLite module (the bug's cause)", /^FAIL .*(different Node\.js version|NODE_MODULE_VERSION)/m.test(underElectron.stdout), underElectron.stdout + underElectron.stderr);

  const electronVersion = spawnSync(electronPath, ['-p', 'process.versions.node'], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).stdout.trim();
  const r = resolveDaemonNode({
    env: { PATH: process.env.PATH ?? '' },
    platform: process.platform,
    loginShellPath: null,
    electron: { execPath: electronPath, nodeVersion: electronVersion },
    isExecutable: (p) => existsSync(p),
    versionOf: (p) => { const o = spawnSync(p, ['--version'], { encoding: 'utf8', timeout: 5000 }); return o.status === 0 ? o.stdout.trim() : null; },
  });
  check('a Node is resolved on this machine', r.ok, r);
  if (r.ok) {
    const underResolved = spawnSync(r.command, ['-e', probe], { cwd: root, encoding: 'utf8', env: { ...process.env, ...r.env }, timeout: 30_000 });
    check(`the resolved Node (${r.version}) opens the SQLite module`, underResolved.stdout.trim() === 'OPEN', underResolved.stdout + underResolved.stderr);

    const home = mkdtempSync(join(tmpdir(), 'tdm-node-check-'));
    const run = spawnSync(r.command, ['--input-type=module', '-e', `
      process.env.TANDEMISE_HOME=${JSON.stringify(home)};
      process.env.TANDEMISE_LOG_LEVEL='error';
      const { startDaemon } = await import(${JSON.stringify(entry)});
      const d = await startDaemon({});
      console.log('UP ' + d.url); await d.stop(); process.exit(0);
    `], { cwd: root, encoding: 'utf8', env: { ...process.env, ...r.env }, timeout: 60_000 });
    check('the daemon starts and opens its database under the resolved Node', /^UP http/m.test(run.stdout), run.stdout.slice(-400) + run.stderr.slice(-400));
    rmSync(home, { recursive: true, force: true });
  }
}

console.log('\n' + '─'.repeat(60));
console.log(failures.length === 0
  ? `ALL ${passed} DAEMON NODE CHECKS PASSED`
  : `${passed} passed, ${failures.length} FAILED:\n  - ${failures.join('\n  - ')}`);
process.exit(failures.length === 0 ? 0 : 1);
