#!/usr/bin/env node
// Seeds a fresh Tandemise install with neutral demo data (project "Taskly", owner "Sam")
// for the screenshots in apps/desktop/screenshots. See README.md in this folder.
//   node scratch/docs-screenshots/seed.mjs
// Starts the daemon and the desktop (electron-vite dev, CDP on DOCS_CDP_PORT) from this
// checkout, seeds them, and leaves both running; capture.mjs takes the pictures and
// stop.mjs kills both. Needs `npm run build` first.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const ROOT = process.env.DOCS_ROOT ?? '/tmp/tdm-docs2';
const PORT = Number(process.env.DOCS_CDP_PORT ?? 9352);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[seed] ${m}`);

// ------------------------------------------------------------ fresh install
try { execFileSync('pkill', ['-f', `user-data-dir=${ROOT}/electron`]); } catch { /* none */ }
if (existsSync(`${ROOT}/env.json`)) { try { process.kill(JSON.parse(readFileSync(`${ROOT}/env.json`, 'utf8')).pid); } catch { /* gone */ } }
await sleep(1500);
rmSync(ROOT, { recursive: true, force: true });
const home = join(ROOT, 'home');
const project = join(ROOT, 'taskly');
mkdirSync(home, { recursive: true });
mkdirSync(join(project, '.tandemise', 'workflows'), { recursive: true });
writeFileSync(join(project, 'README.md'), '# Taskly\n\nA small task board.\n');
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'taskly', private: true, scripts: { test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"' } }, null, 2));
writeFileSync(join(project, '.gitignore'), '.tandemise/out/\nnode_modules/\n');
writeFileSync(join(project, '.tandemise/workflows/deliver.yaml'), `name: Spec, QA and release
description: Write the spec, verify every criterion, assemble the release candidate.
steps:
  - key: spec
    role: product
    objective: Write the product spec for this change.
    outputs: [ProductSpec]
    gate: artifact.ProductSpec.exists && criteria.uncovered_user == 0 && criteria.unknown_covers == 0 && criteria.total >= 1
  - key: qa
    role: qa
    dependsOn: [spec]
    objective: Verify the change against every criterion.
    inputs: [ProductSpec]
    isolation: none
    outputs: [QAReport]
    gate: artifact.QAReport.exists && qa.criteria_failed == 0
  - key: release
    role: release
    dependsOn: [qa]
    objective: Assemble the release candidate.
    inputs: [QAReport]
    outputs: [ReleaseCandidate]
    gate: artifact.ReleaseCandidate.exists && qa.criteria_unverified == 0 && qa.blocking_defects == 0
`);
writeFileSync(join(project, '.tandemise/workflows/investigate.yaml'), `name: Investigate
description: One step that records what was found and decided.
steps:
  - key: investigate
    role: product
    objective: Find the cause and record what should change.
    outputs: [DecisionRecord]
`);
writeFileSync(join(project, '.tandemise/workflows/copy.yaml'), `name: Copy pass
description: Five short writing steps, one after another.
steps:
  - key: brief
    role: product
    objective: Write the brief for the new copy.
    outputs: [ProblemBrief]
  - key: spec
    role: product
    dependsOn: [brief]
    objective: Write the spec for the new copy.
    inputs: [ProblemBrief]
    outputs: [ProductSpec]
  - key: design
    role: design
    dependsOn: [spec]
    objective: Lay out the new copy.
    inputs: [ProductSpec]
    outputs: [DesignBrief]
  - key: decide
    role: product
    dependsOn: [design]
    objective: Record the decision to ship the new copy.
    inputs: [DesignBrief]
    outputs: [DecisionRecord]
  - key: wrap
    role: product
    dependsOn: [decide]
    objective: Write the closing brief.
    inputs: [DecisionRecord]
    outputs: [ProblemBrief]
`);
const git = (...args) => execFileSync('git', ['-c', 'user.name=Taskly', '-c', 'user.email=taskly@example.invalid', ...args], { cwd: project, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
git('add', '.');
git('commit', '-q', '-m', 'init');

// ------------------------------------------------------------ demo agent
const demoAgent = join(ROOT, 'demo-agent.mjs');
execFileSync(process.execPath, [fileURLToPath(new URL('./make-demo-agent.mjs', import.meta.url)), demoAgent], { stdio: 'inherit' });

// ------------------------------------------------------------------ daemon
const handshake = join(home, 'daemon.json');
const dlog = openSync(join(ROOT, 'daemon.log'), 'a');
const daemon = spawn(process.execPath, [join(REPO, 'apps/daemon/dist/main.js')], {
  detached: true,
  stdio: ['ignore', dlog, dlog],
  env: {
    ...process.env,
    TANDEMISE_HOME: home,
    TANDEMISE_OWNER_NAME: 'Sam',
    TANDEMISE_QUIET_MS: '20000',
    TANDEMISE_CLOCK_OFFSET_MS: '0',
    SCRIPTED_DELAY_MS: '1500',
    SCRIPTED_HANG_MS: '7200000',
    SCRIPTED_STATE_DIR: join(ROOT, 'scripted-state'),
    SCRIPTED_PROMPT_DIR: join(ROOT, 'prompts'),
  },
});
daemon.unref();
let info;
for (const end = Date.now() + 20_000; ;) {
  if (existsSync(handshake)) { const next = JSON.parse(readFileSync(handshake, 'utf8')); if (next.pid === daemon.pid) { info = next; break; } }
  if (Date.now() > end) throw new Error('daemon did not start');
  await sleep(200);
}
const api = async (method, path, body) => {
  const res = await fetch(`${info.url}${path}`, { method, headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
};
const until = async (fn, label, timeoutMs = 180_000) => {
  for (const end = Date.now() + timeoutMs; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${label}`); await sleep(700); }
};

log(`workspaces before: ${JSON.stringify((await api('GET', '/v1/workspaces')).map((w) => w.name ?? w.workspace?.name))}`);
const ws = await api('POST', '/v1/workspaces', { name: 'Taskly', repositoryPath: project });
const workspaceId = ws.id ?? ws.workspace?.id;
const agentProfile = await api('POST', '/v1/runtimes', {
  adapterId: 'generic-cli', name: 'Demo agent', workspaceId: null,
  // Plain `node` from PATH, so the Runtimes screen shows no machine-specific install path.
  settings: { command: 'node', args: [demoAgent], promptVia: 'stdin', outputFormat: 'ndjson', capabilities: ['reasoning', 'tool_calling', 'shell', 'git', 'filesystem', 'mcp'] },
  maxConcurrent: 6, enabled: true,
});
writeFileSync(join(ROOT, 'env.json'), JSON.stringify({ url: info.url, token: info.token, pid: info.pid, home, workspaceId }, null, 2));

// ------------------------------------------------------------------ desktop
const desktop = spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${PORT}`, `--user-data-dir=${ROOT}/electron`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
  cwd: join(REPO, 'apps/desktop'), env: { ...process.env, TANDEMISE_HOME: home }, stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
desktop.unref();
writeFileSync(join(ROOT, 'desktop.pid'), String(desktop.pid));

// ------------------------------------------------------------------ missions
const create = async (body) => (await api('POST', '/v1/missions', { workspaceId, ...body })).mission?.id ?? (await api('GET', '/v1/missions?workspaceId=' + workspaceId)).find(() => false);
const approvals = async (missionId, status) => (await api('GET', `/v1/approvals?missionId=${missionId}${status ? `&status=${status}` : ''}`)).map((v) => v.approval);
const approvePlan = async (missionId) => {
  const plan = await until(async () => (await approvals(missionId, 'PENDING')).find((a) => a.kind === 'plan'), 'plan card');
  await api('POST', `/v1/approvals/${plan.id}/decide`, { optionId: 'approve' });
};
const card = (missionId, label) => until(async () => (await approvals(missionId, 'PENDING')).find((a) => a.kind === 'intervention'), label, 240_000);

log('B: stalled after its release is left blocked');
const b = await create({ title: 'Remember the last board you opened', goal: 'When someone opens Taskly, show the board they had open last time.', constraints: ['SCRIPTED_SPEC_THREE_ACS', 'SCRIPTED_FAIL_RELEASE'], successCriteria: ['Reopening Taskly shows the board that was open last', 'A deleted board falls back to the first board'], workflowPreset: 'deliver', priority: 'normal', planNow: true });
await approvePlan(b);
const bCard = await card(b, 'B release card');
await api('POST', `/v1/approvals/${bCard.id}/decide`, { optionId: 'reject' });

log('A: QA verifies one of three; release waits on a card');
const a = await create({ title: 'Export reports as CSV', goal: 'Let people download any report as a CSV file they can open in a spreadsheet.', constraints: ['SCRIPTED_QA_PARTIAL'], successCriteria: ['Any report can be downloaded as a CSV file', 'The CSV opens in a spreadsheet with one row per task'], workflowPreset: 'deliver', priority: 'high', planNow: true });
await approvePlan(a);
await card(a, 'A release card');

log('C: an agent that goes quiet');
const c = await create({ title: 'Find why the board loads slowly', goal: 'Find why the board takes several seconds to show its first cards, and record what should change.', constraints: ['SCRIPTED_HANG_ONCE'], successCriteria: ['The cause of the slow first load is written down with evidence'], workflowPreset: 'investigate', planNow: true });
await approvePlan(c);

log('D: stops at its limit');
const d = await create({ title: 'Rewrite the onboarding emails', goal: 'Rewrite the three onboarding emails so each one asks for one action.', constraints: ['SCRIPTED_USAGE_MIN=5'], successCriteria: ['Each onboarding email asks for exactly one action'], workflowPreset: 'copy', limits: [{ metric: 'agent_minutes', amount: 12, warnPercent: 80 }], planNow: true });
await approvePlan(d);
await card(d, 'D limit card');

log('month limit and drafts');
await api('PATCH', `/v1/workspaces/${workspaceId}`, { monthlyLimits: [{ metric: 'agent_minutes', amount: 18, warnPercent: 80 }] });
const e = await create({ title: 'Add keyboard shortcuts to the board', goal: 'Let people move between cards and columns with the keyboard.', successCriteria: ['Arrow keys move the selection between cards', 'A shortcut list opens with the ? key'], workflowPreset: 'deliver', priority: 'high', queued: true });
const f = await create({ title: 'Show due dates on cards', goal: 'Show each card\'s due date on the board, and mark overdue ones.', successCriteria: ['A card with a due date shows it on the board', 'An overdue card is marked as overdue'], workflowPreset: 'deliver', priority: 'normal', queued: true });
const g = await create({ title: 'Archive finished boards', goal: 'Let people archive a board they no longer use, and bring it back later.', successCriteria: ['An archived board is hidden from the board list', 'An archived board can be restored'], workflowPreset: 'deliver', priority: 'low' });
const h = await create({ title: 'Share a board by link', goal: 'Let people share a read-only board with someone outside the team.', workflowPreset: 'deliver', priority: 'normal' });

log('H: refine');
await api('POST', `/v1/missions/${h}/refine`);
const ref = await until(async () => { const r = await api('GET', `/v1/missions/${h}/refinement`); return r.state === 'idle' && r.criteria?.some((x) => x.status === 'proposed') && r; }, 'refinement');
const first = ref.criteria.find((x) => x.status === 'proposed');
await api('POST', `/v1/criteria/${first.id}/verdict`, { verdict: 'accept' });

log('WIP limit = work in progress');
const home0 = await api('GET', `/v1/home?workspaceId=${workspaceId}`);
await api('PATCH', `/v1/workspaces/${workspaceId}`, { maxActiveMissions: home0.metrics.active });

log('routines');
const deps = await api('POST', `/v1/workspaces/${workspaceId}/routines`, { name: 'Weekly dependency updates', kind: 'mission', goal: 'Update the project\'s dependencies to their latest compatible versions, run the tests, and fix anything the updates break.', successCriteria: ['Every direct dependency is on its latest compatible version, or the reason it is held back is written down', 'The test suite passes after the updates'], priority: 'normal', workflowPreset: 'deliver', schedule: { type: 'weekly', day: 1, at: '09:00' } });
const report = await api('POST', `/v1/workspaces/${workspaceId}/routines`, { name: 'Weekly status report', kind: 'status_report', successCriteria: ['Every mission in progress is listed with its criteria verified'], schedule: { type: 'weekly', day: 5, at: '16:00' } });
await api('POST', `/v1/workspaces/${workspaceId}/routines`, { name: 'Nightly: fix failing checks', kind: 'mission', goal: 'Find the checks that fail on the default branch and fix the cause of each one.', successCriteria: ['Every check that failed at the start passes'], priority: 'high', workflowPreset: 'deliver', schedule: { type: 'daily', at: '02:00' }, enabled: false });
const idOf = (r) => r.routine?.id ?? r.id;
await api('POST', `/v1/routines/${idOf(report)}/run-now`);
await api('POST', `/v1/routines/${idOf(deps)}/run-now`);

log('team: you and four agents on the demo runtime');
const team = await api('GET', `/v1/workspaces/${workspaceId}/team`);
const owner = team.members.find((m) => m.kind === 'person' && m.access === 'owner');
const runtimeId = agentProfile.profile?.id ?? agentProfile.id;
for (const [name, roleIds, title] of [
  ['Product agent', ['product', 'design'], 'Writes specs and layouts'],
  ['Coding agent', ['development', 'architecture'], 'Builds the change'],
  ['QA agent', ['qa', 'review'], 'Checks every criterion'],
  ['Release agent', ['release'], 'Assembles the release'],
]) {
  await api('POST', `/v1/workspaces/${workspaceId}/members`, { kind: 'agent', name, reportsTo: owner.id, roleIds, title, runtimeProfileIds: [runtimeId] });
}

writeFileSync(join(ROOT, 'state.json'), JSON.stringify({ workspaceId, a, b, c, d, e, f, g, h }, null, 2));
log('waiting for C to be silent');
await until(async () => (await api('GET', `/v1/inbox?workspaceId=${workspaceId}`)).silentRuns?.length > 0, 'silent run', 240_000);
const fin = await api('GET', `/v1/home?workspaceId=${workspaceId}`);
log(`metrics ${JSON.stringify(fin.metrics)}`);
log(`banners ${JSON.stringify(fin.banners)}`);
log('done');
