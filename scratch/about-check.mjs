// Settings → About and "Copy diagnostics": which code is running, where its
// data lives, and a plain-text block for a bug report that never carries a
// token or a secret.
//
//   npm run build && node scratch/about-check.mjs
//
// Pure rules first (the copied text, the version check, uptime), then the
// daemon's build stamp (`dist/build-info.json`, the TANDEMISE_BUILD knob), then
// a real daemon: `GET /v1/system` reports its version and build, and the text
// built from that real answer, with the real bearer token lying next to it,
// does not contain the token.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 700)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);

const About = await import('@tandemise/api-contract/about');
const rootVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const desktopVersion = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version;
let gitSha = 'dev';
try { gitSha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { /* no git */ }

// Secrets that must never reach the clipboard, planted everywhere a careless
// implementation would pick them up: extra fields on the facts objects and a
// connection object with a token.
const TOKEN = 'tdm_4f9c2e7a1b3d5f8e0a2c4e6b8d0f1a3c';
const API_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
const app = {
  version: '0.5.0', build: 'a1b2c3d', electron: '33.4.11', chrome: '130.0.6723.191', node: '20.18.3',
  os: 'macOS 15.0 (arm64)', userHome: '/Users/someone',
  token: TOKEN, env: { ANTHROPIC_API_KEY: API_KEY },
};
const daemon = {
  daemonVersion: '0.5.0', daemonBuild: 'a1b2c3d', apiVersion: 'v1', schemaVersion: 42,
  startedAt: '2026-09-26T10:00:00.000Z', pid: 4242, home: '/Users/someone/.tandemise', platform: 'darwin-arm64', nodeVersion: 'v22.23.1',
  connection: { url: 'http://127.0.0.1:5555', token: TOKEN }, authorization: `Bearer ${TOKEN}`, settings: { apiKey: API_KEY },
};
const NOW = Date.parse('2026-09-26T13:05:00.000Z');

// ------------------------------------------------------------------ pure
section('pure: the copied diagnostics');
{
  const text = About.diagnosticsText({ app, daemon, daemonState: 'Running', now: NOW });
  check('has the app version and build', text.includes('Version: 0.5.0 (a1b2c3d)'), text);
  check('has Electron, Chromium, Node and the OS', ['Electron: 33.4.11', 'Chromium: 130.0.6723.191', 'Node (app): 20.18.3', 'OS: macOS 15.0 (arm64)'].every((s) => text.includes(s)), text);
  check('has the daemon status, API, schema and uptime', ['Status: Running', 'API: v1', 'Database schema: 42', 'Uptime: 3h 5m', 'Process id: 4242', 'Node (daemon): v22.23.1'].every((s) => text.includes(s)), text);
  check('has the data folder, with the home folder shown as ~', text.includes('Data folder: ~/.tandemise') && !text.includes('/Users/someone'), text);
  check('says there is no mismatch', text.includes('Mismatch: none'), text);
  check('never contains the token', !text.includes(TOKEN) && !text.includes(TOKEN.slice(4, 20)), text);
  check('never contains an API key', !text.includes(API_KEY) && !text.includes('sk-ant-'), text);
  check('never contains "Bearer" or "token"', !/bearer/i.test(text) && !/token/i.test(text), text);
  check('is plain text: no JSON braces', !/[{}]/.test(text), text);
  check('ends with a newline, one fact per line', text.endsWith('\n') && text.split('\n').every((l) => l.length < 120));

  const down = About.diagnosticsText({ app, daemon: null, daemonState: 'Not connected', now: NOW });
  check('with the daemon down it says so and still has the app side', down.includes('Status: Not connected') && down.includes('not connected, so its version') && down.includes('Electron: 33.4.11') && !down.includes('Mismatch'), down);
  const noApp = About.diagnosticsText({ app: null, daemon, daemonState: 'Running', now: NOW });
  check('without app facts the daemon side is still there, path unshortened', noApp.includes('(not available)') && noApp.includes('Data folder: /Users/someone/.tandemise'), noApp);
  const injected = About.diagnosticsText({ app: { ...app, os: 'macOS\nToken: leaked' }, daemon, daemonState: 'Running', now: NOW });
  check('a value cannot add its own line', !injected.split('\n').some((l) => l.startsWith('Token')), injected);
}

section('pure: the version check');
{
  check('same version and build: no mismatch', About.versionMismatch(app, daemon) === null);
  const v = About.versionMismatch({ version: '0.5.0', build: 'a1b2c3d' }, { daemonVersion: '0.4.0', daemonBuild: 'a1b2c3d' });
  check('different versions: a version mismatch', v?.kind === 'version' && v.app === '0.5.0' && v.daemon === '0.4.0', v);
  const b = About.versionMismatch({ version: '0.5.0', build: 'a1b2c3d' }, { daemonVersion: '0.5.0', daemonBuild: '0000000' });
  check('same version, different commits: a build mismatch', b?.kind === 'build' && b.daemon === '0000000', b);
  check('a dev build on either side is not a mismatch', About.versionMismatch({ version: '0.5.0', build: 'dev' }, { daemonVersion: '0.5.0', daemonBuild: '0000000' }) === null
    && About.versionMismatch({ version: '0.5.0', build: 'a1b2c3d' }, { daemonVersion: '0.5.0', daemonBuild: 'dev' }) === null);
  const advice = About.mismatchAdvice(v, 4242);
  check('the version advice names both versions and says to restart the daemon', advice.includes('0.5.0') && advice.includes('0.4.0') && advice.includes('Restart the daemon') && advice.includes('kill 4242') && advice.includes('npm run daemon') && !advice.includes('Retry'), advice);
  const buildAdvice = About.mismatchAdvice(b, null);
  check('the build advice says to build, then restart', buildAdvice.includes('npm run build') && buildAdvice.includes('stop the daemon') && buildAdvice.includes('npm run daemon'), buildAdvice);
  const text = About.diagnosticsText({ app, daemon: { ...daemon, daemonVersion: '0.4.0' }, daemonState: 'Running', now: NOW });
  check('the copied text records the mismatch', text.includes('Mismatch: version (app 0.5.0, daemon 0.4.0)'), text);
}

section('pure: uptime and versions');
{
  const start = '2026-09-26T10:00:00.000Z';
  const t = (ms) => About.uptimeText(start, Date.parse(start) + ms);
  check('uptime texts', t(20_000) === 'under a minute' && t(5 * 60_000) === '5m' && t(3 * 3_600_000 + 12 * 60_000) === '3h 12m' && t(2 * 86_400_000 + 4 * 3_600_000) === '2d 4h', [t(20_000), t(5 * 60_000), t(3 * 3_600_000 + 12 * 60_000), t(2 * 86_400_000 + 4 * 3_600_000)]);
  check('an unreadable start is unknown, a clock behind the start is under a minute', About.uptimeText('nope', NOW) === 'unknown' && About.uptimeText(start, Date.parse(start) - 5000) === 'under a minute');
  check('version with build', About.versionWithBuild('0.5.0', 'a1b2c3d') === '0.5.0 (a1b2c3d)' && About.versionWithBuild('0.5.0', 'dev') === '0.5.0 (dev build)');
  check('links point at the repository', About.TANDEMISE_REPOSITORY_URL === 'https://github.com/demogar/tandemise'
    && About.TANDEMISE_NEW_ISSUE_URL.startsWith('https://github.com/demogar/tandemise/issues/new')
    && About.TANDEMISE_DOCS_URL.startsWith('https://github.com/demogar/tandemise/'));
}

// ------------------------------------------------------------------ build stamp
section('daemon: the build stamp');
const configModule = await import(pathToFileURL(join(root, 'apps/daemon/dist/config.js')).href);
{
  const stamped = JSON.parse(readFileSync(join(root, 'apps/daemon/dist/build-info.json'), 'utf8'));
  check('npm run build wrote dist/build-info.json with this commit', stamped.build === gitSha, { stamped, gitSha });
  const scratchDir = mkdtempSync(join(tmpdir(), 'tdm-about-'));
  try {
    const good = join(scratchDir, 'good.json');
    const bad = join(scratchDir, 'bad.json');
    writeFileSync(good, JSON.stringify({ build: 'abc1234' }));
    writeFileSync(bad, JSON.stringify({ build: 'rm -rf /; echo' }));
    check('readBuildInfo reads a commit', configModule.readBuildInfo(pathToFileURL(good)) === 'abc1234');
    check('readBuildInfo refuses a value that is not a commit', configModule.readBuildInfo(pathToFileURL(bad)) === 'dev');
    check('readBuildInfo falls back to dev when the file is missing', configModule.readBuildInfo(pathToFileURL(join(scratchDir, 'missing.json'))) === 'dev');
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
  const saved = process.env.TANDEMISE_BUILD;
  process.env.TANDEMISE_BUILD = '0000000';
  check('TANDEMISE_BUILD overrides the stamp (the real-app mismatch knob)', configModule.loadConfig({ home: tmpdir() }).build === '0000000');
  delete process.env.TANDEMISE_BUILD;
  check('without it, the config carries the stamp', configModule.loadConfig({ home: tmpdir() }).build === gitSha);
  check('the daemon version is the release version', configModule.loadConfig({ home: tmpdir() }).version === rootVersion && rootVersion === desktopVersion, { rootVersion, desktopVersion });
  if (saved !== undefined) process.env.TANDEMISE_BUILD = saved;
}

section('desktop: the About panel says what NOTICE says');
{
  const notice = readFileSync(join(root, 'NOTICE'), 'utf8');
  const holder = notice.split('\n').find((l) => l.startsWith('Copyright'));
  const aboutSource = readFileSync(join(root, 'apps/desktop/src/main/about.ts'), 'utf8');
  check('the copyright line is NOTICE word for word', holder !== undefined && aboutSource.includes(`'${holder.trim()}'`), holder);
  check('the panel names the Apache-2.0 license', aboutSource.includes('Apache License, Version 2.0'));
  check('the panel sets version (our build), copyright, credits and website', ['version:', 'copyright:', 'credits:', 'website:'].every((k) => aboutSource.includes(k)));
  const settingsSource = readFileSync(join(root, 'apps/desktop/src/renderer/src/screens/SettingsAbout.tsx'), 'utf8');
  check('Copy diagnostics copies diagnosticsText, never a serialised object', settingsSource.includes('diagnosticsText(') && !settingsSource.includes('JSON.stringify'));
}

// ------------------------------------------------------------------ real daemon
section('daemon: GET /v1/system and the text built from it');
{
  const home = mkdtempSync(join(tmpdir(), 'tdm-about-d-'));
  const { startDaemon } = await import(pathToFileURL(join(root, 'apps/daemon/dist/main.js')).href);
  const running = await startDaemon({ home, logLevel: 'error' });
  try {
    const handshake = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8'));
    const res = await fetch(`${running.url}/v1/system`, { headers: { authorization: `Bearer ${handshake.token}`, 'x-tandemise-api-version': 'v1' } });
    const raw = await res.text();
    const system = JSON.parse(raw);
    check('GET /v1/system → 200', res.status === 200, res.status);
    check('reports the daemon version and build', system.daemonVersion === rootVersion && system.daemonBuild === gitSha, system);
    check('reports the schema version and the data folder', Number.isInteger(system.schemaVersion) && system.schemaVersion > 0 && system.home === home, system);
    check('the route itself carries no token', !raw.includes(handshake.token));
    const unauth = await fetch(`${running.url}/v1/system`, { headers: { 'x-tandemise-api-version': 'v1' } });
    check('and needs the token to be read', unauth.status === 401 || unauth.status === 403, unauth.status);
    // What the renderer does: the real system answer, with the connection (and its token) in reach.
    const text = About.diagnosticsText({
      app: { ...app, version: desktopVersion, build: gitSha },
      daemon: { ...system, connection: handshake },
      daemonState: 'Running',
      now: Date.now(),
    });
    check('the copied text has both versions and the schema', text.includes(`Version: ${desktopVersion} (${gitSha})`) && text.includes(`Version: ${system.daemonVersion} (${system.daemonBuild})`) && text.includes(`Database schema: ${system.schemaVersion}`), text);
    check('the copied text has no bearer token', !text.includes(handshake.token) && !/bearer/i.test(text), text);
    check('real versions agree: no mismatch', text.includes('Mismatch: none'), text);
  } catch (e) {
    failures.push(`threw: ${e?.stack ?? e}`);
    console.log(e);
  } finally {
    await running.stop();
    rmSync(home, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
console.log('ALL ABOUT CHECKS PASSED');
