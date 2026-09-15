#!/usr/bin/env node
// Builds a Tandemise installation that exists only for an acceptance run.
//
//   node scratch/acceptance/p0/setup.mjs <scratch-dir>
//
// Creates <scratch-dir>/home (TANDEMISE_HOME), a throwaway git project with the
// scenario workflow, starts the daemon from this checkout's build against that
// home, registers the project and a scripted-agent runtime, and writes
// <scratch-dir>/env.json with everything the scenario driver needs.
//
// Nothing here touches ~/.tandemise or the user's own app window: the desktop
// for the run is launched separately with the same TANDEMISE_HOME and its own
// --user-data-dir.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.TANDEMISE_REPO_ROOT ?? resolve(here, '../../..');
const scratch = resolve(process.argv[2] ?? '');
if (!process.argv[2]) { console.error('usage: setup.mjs <scratch-dir>'); process.exit(2); }

const home = join(scratch, 'home');
const project = join(scratch, 'project');
mkdirSync(home, { recursive: true });

// ------------------------------------------------------------------ project
if (!existsSync(join(project, '.git'))) {
  mkdirSync(join(project, '.tandemise', 'workflows'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Acceptance project\n');
  writeFileSync(join(project, 'package.json'), JSON.stringify({
    name: 'acceptance-project', private: true,
    scripts: { test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"' },
  }, null, 2));
  writeFileSync(join(project, '.gitignore'), '.tandemise/out/\nnode_modules/\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project, stdio: 'ignore' });
}
// Every scenario workflow, for a project that already exists too: a later suite may bring new ones.
mkdirSync(join(project, '.tandemise', 'workflows'), { recursive: true });
for (const file of readdirSync(join(here, 'workflows')).filter((f) => f.endsWith('.yaml'))) {
  copyFileSync(join(here, 'workflows', file), join(project, '.tandemise', 'workflows', file));
}
{
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@example.invalid', ...args], { cwd: project, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  if (git('status', '--porcelain').trim() !== '') {
    git('add', '.');
    git('commit', '-q', '-m', existsSync(join(project, '.git', 'refs', 'heads', 'main')) ? 'workflows' : 'init');
  }
}

// ------------------------------------------------------------------- daemon
const handshake = join(home, 'daemon.json');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let info = existsSync(handshake) ? JSON.parse(readFileSync(handshake, 'utf8')) : null;
if (info === null || !alive(info.pid)) {
  const log = openSync(join(scratch, 'daemon.log'), 'a');
  const child = spawn(process.execPath, [join(repoRoot, 'apps/daemon/dist/main.js')], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, TANDEMISE_HOME: home, SCRIPTED_DELAY_MS: process.env.SCRIPTED_DELAY_MS ?? '1500', SCRIPTED_PROMPT_DIR: join(scratch, 'prompts') },
  });
  child.unref();
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (existsSync(handshake)) {
      const next = JSON.parse(readFileSync(handshake, 'utf8'));
      if (next.pid === child.pid) { info = next; break; }
    }
    if (Date.now() > deadline) throw new Error(`daemon did not start; see ${join(scratch, 'daemon.log')}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const api = async (method, path, body) => {
  const res = await fetch(`${info.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return json;
};

// ------------------------------------------------------ workspace + runtime
let workspace = (await api('GET', '/v1/workspaces')).find((w) => w.name === 'Acceptance' || w.workspace?.name === 'Acceptance');
if (!workspace) workspace = await api('POST', '/v1/workspaces', { name: 'Acceptance', repositoryPath: project });
const workspaceId = workspace.id ?? workspace.workspace?.id;

const profiles = await api('GET', `/v1/runtimes?workspaceId=${workspaceId}`);
let scripted = profiles.find((p) => (p.profile?.name ?? p.name) === 'Scripted agent');
if (!scripted) {
  scripted = await api('POST', '/v1/runtimes', {
    adapterId: 'generic-cli',
    name: 'Scripted agent',
    workspaceId: null,
    settings: {
      command: process.execPath,
      args: [join(here, 'scripted-agent.mjs')],
      promptVia: 'stdin',
      outputFormat: 'text',
      capabilities: ['reasoning', 'tool_calling', 'shell', 'git', 'filesystem', 'mcp'],
    },
    maxConcurrent: 4,
    enabled: true,
  });
}
const scriptedId = scripted.profile?.id ?? scripted.id;

const env = { scratch, home, project, url: info.url, token: info.token, pid: info.pid, workspaceId, scriptedProfileId: scriptedId };
writeFileSync(join(scratch, 'env.json'), JSON.stringify(env, null, 2));
console.log(JSON.stringify({ ...env, token: '<redacted>' }, null, 2));
