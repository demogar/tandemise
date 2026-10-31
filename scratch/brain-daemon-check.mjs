/**
 * #51: the brain through the daemon's HTTP API.
 *
 * Starts the daemon from `dist` in this process with a fresh TANDEMISE_HOME,
 * TANDEMISE_OFFLINE=1 and a fake `gh` first on PATH. A git config passed as
 * GIT_CONFIG_GLOBAL turns https://github.com/ into local bare repositories, so
 * nothing reaches the network.
 *
 *   npm run build && node scratch/brain-daemon-check.mjs
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const ROOT = mkdtempSync(join(tmpdir(), 'tdm-brain-daemon-'));
const FAKE = { bin: join(ROOT, 'bin'), log: join(ROOT, 'gh-log.jsonl'), state: join(ROOT, 'gh-state'), remotes: join(ROOT, 'remotes'), gitconfig: join(ROOT, 'gitconfig') };
mkdirSync(FAKE.bin, { recursive: true });
mkdirSync(FAKE.remotes, { recursive: true });
writeFileSync(join(FAKE.bin, 'gh'), `#!/bin/sh\nFAKE_GH_LOG='${FAKE.log}' FAKE_GH_STATE='${FAKE.state}' FAKE_GH_REMOTES='${FAKE.remotes}' exec '${process.execPath}' '${join(here, 'brain-fixtures', 'fake-gh.mjs')}' "$@"\n`);
chmodSync(join(FAKE.bin, 'gh'), 0o755);
writeFileSync(FAKE.gitconfig, `[url "file://${FAKE.remotes}/"]\n\tinsteadOf = https://github.com/\n[user]\n\tname = Ana Smith\n\temail = ana@localhost\n[init]\n\tdefaultBranch = main\n`);
process.env.PATH = `${FAKE.bin}:${process.env.PATH}`;
process.env.GIT_CONFIG_GLOBAL = FAKE.gitconfig;
process.env.TANDEMISE_OFFLINE = '1';
const ghLog = () => (existsSync(FAKE.log) ? readFileSync(FAKE.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const remoteDir = join(FAKE.remotes, 'garipass', 'brain.git');

globalThis.__sqlite = await import('node:sqlite');
const { startDaemon } = await import('../apps/daemon/dist/main.js');

async function daemonAt(name) {
  const home = join(ROOT, name);
  const daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 300 });
  const token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
  const api = async (method, path, body) => {
    const res = await fetch(`${daemon.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const repoDir = join(home, 'code');
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, 'init', '-q', '-b', 'main');
  writeFileSync(join(repoDir, 'README.md'), '# garipass\n');
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-q', '-m', 'init');
  const ws = (await api('POST', '/v1/workspaces', { name: 'Garipass', repositoryPath: repoDir })).body?.workspace?.id;
  return { home, daemon, api, ws, repoDir };
}

let d1;
let d2;
try {
  section('daemon: create a brain, refuse a second, adopt, offline, local');
  d1 = await daemonAt('home1');
  const unlinked = await d1.api('GET', `/v1/workspaces/${d1.ws}/brain`);
  check('GET brain on a new project is unlinked', unlinked.status === 200 && unlinked.body?.linked === false && unlinked.body.status === 'unlinked', unlinked);

  const created = await d1.api('POST', `/v1/workspaces/${d1.ws}/brain`, { mode: 'create', owner: 'garipass', name: 'brain' });
  check('POST create links the brain', created.status === 200 && created.body?.status === 'up_to_date', created);
  check('fake gh saw repo create --private', ghLog().some((l) => l.argv.join(' ') === 'repo create garipass/brain --private'));
  const tree = git(remoteDir, 'ls-tree', '-r', '--name-only', 'main');
  check('the remote has brain.yaml, a role and project rules', ['brain.yaml', 'factory/roles/development.md', 'memory/rules/project.md'].every((f) => tree.includes(f)), tree);

  const again = await d1.api('POST', `/v1/workspaces/${d1.ws}/brain`, { mode: 'create', owner: 'garipass', name: 'brain' });
  check('a second create is refused in words', again.status === 409 && again.body?.error?.message === 'This project already has a brain: github.com/garipass/brain.', again);
  check('factory/ holds no personal fields', !/(^|[\s'"])\/(home|Users|tmp|private)\//.test(git(remoteDir, 'log', '-p', '--all', '--', 'factory')));

  const synced = await d1.api('POST', `/v1/workspaces/${d1.ws}/brain/sync`);
  check('POST sync answers the view', synced.status === 200 && synced.body?.linked === true, synced);

  renameSync(remoteDir, `${remoteDir}.gone`);
  const off = await d1.api('POST', `/v1/workspaces/${d1.ws}/brain/sync`);
  check('offline sync says it works from your copy', off.body?.status === 'offline' && off.body.statusLine.startsWith('Working from your copy of the brain'), off.body);
  renameSync(`${remoteDir}.gone`, remoteDir);
  await d1.daemon.stop();
  d1 = undefined;

  d2 = await daemonAt('home2');
  const preview = await d2.api('POST', `/v1/workspaces/${d2.ws}/brain`, { mode: 'adopt', remote: 'github.com/garipass/brain' });
  check('adopt answers a preview with items and a hash', preview.status === 200 && typeof preview.body?.hash === 'string' && Array.isArray(preview.body.items), preview);
  const linked = await d2.api('POST', `/v1/workspaces/${d2.ws}/brain/link`, { hash: preview.body?.hash, choices: {} });
  check('link applies the preview', linked.status === 200 && linked.body?.linked === true, linked);
  section('daemon: Remember this, votes and the lessons list');
  const saved = await d2.api('POST', `/v1/workspaces/${d2.ws}/brain/entries`, { text: `Use ghp_${'q'.repeat(36)} never; run npm run ci.`, scope: { role: 'development' } });
  check('POST entries saves a lesson and says where it applies', saved.status === 200 && saved.body?.message?.startsWith('Saved. Agents on Developer') && saved.body.entry.text.includes('[redacted secret]'), saved);
  const voted = await d2.api('POST', `/v1/brain/entries/${encodeURIComponent(saved.body?.entry?.id ?? 'x')}/vote`, { vote: 'helpful' });
  check('a thumbs up counts three', voted.body?.net === 3, voted.body);
  const listed = await d2.api('GET', `/v1/workspaces/${d2.ws}/brain/entries`);
  check('GET entries lists it with its source', listed.body?.some?.((e) => e.id === saved.body?.entry?.id && e.sourceLabel === 'you'), listed.body);
  await d2.api('POST', `/v1/workspaces/${d2.ws}/brain/sync`);
  check('after sync the remote has the lesson and no token', git(remoteDir, 'log', '-p', '--all').includes('run npm run ci') && !git(remoteDir, 'log', '-p', '--all').includes('ghp_q'));
  const refused = await d2.api('POST', `/v1/workspaces/${d2.ws}/brain/entries`, { text: 'see /etc/hosts' });
  check('a machine path is refused in words', refused.status === 400 && refused.body?.error?.message === "A lesson can't name a path on your machine. Name the file inside its repository instead.", refused.body);

  const side = (await d2.api('POST', '/v1/workspaces', { name: 'Side', repositoryPath: d2.repoDir })).body?.workspace?.id;
  const local = await d2.api('POST', `/v1/workspaces/${side}/brain`, { mode: 'local' });
  check('local mode is local_only', local.body?.status === 'local_only', local);
  const gone = await d2.api('DELETE', `/v1/workspaces/${side}/brain`);
  check('DELETE unlinks', gone.body?.linked === false, gone);
} catch (e) {
  failures.push(`threw: ${e?.stack ?? e}`);
  console.log(e);
} finally {
  await d1?.daemon.stop().catch(() => {});
  await d2?.daemon.stop().catch(() => {});
  await sleep(100);
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
