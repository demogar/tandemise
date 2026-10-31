// Shared by the relay scenarios: one or two real windows (each with its own
// home and daemon from this checkout), issue-linked missions, and the relay
// started from apps/relay/dist.
import { readFileSync, existsSync, openSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { loadEnv, client, until, sleep } from '../p0/lib/api.mjs';
import { connect } from '../p0/lib/cdp.mjs';
import { ui as makeUi } from '../p0/lib/ui.mjs';

export { until, sleep };
export const EVIDENCE = process.env.ACCEPTANCE_EVIDENCE_DIR;
export const DEVICE_LABEL = hostname();

/** A window and its daemon: the CDP page, the API client and the helpers a scenario repeats. */
export async function windowFor(scratch, port) {
  const env = loadEnv(scratch);
  const api = client(env);
  const page = await connect(port, { timeoutMs: 90_000 });
  await page.waitForText('Daemon connected', { timeoutMs: 90_000 });
  const ui = makeUi(page);
  const w = {
    scratch, env, api, page, ui,
    /** Home's "Who's working on what" section text. */
    whoText: () => page.evaluate(`document.querySelector('section[aria-label="Who\\'s working on what"]')?.innerText ?? ''`),
    async openHome() {
      await page.navigate('#/');
      await until(() => page.evaluate(`Boolean(document.querySelector('section[aria-label="Who\\'s working on what"]'))`), { label: "Who's working on what", timeoutMs: 20_000 });
    },
    /** The topmost dialog's text, by its aria-label. */
    dialogText: (label) => page.evaluate(`[...document.querySelectorAll('[role=dialog]')].filter((d) => d.getAttribute('aria-label') === ${JSON.stringify(label)}).pop()?.innerText ?? ''`),
    dialogButtons: (label) => page.evaluate(`[...([...document.querySelectorAll('[role=dialog]')].filter((d) => d.getAttribute('aria-label') === ${JSON.stringify(label)}).pop()?.querySelectorAll('button') ?? [])].map((b) => b.innerText.trim())`),
    async clickInDialog(label, button) {
      const ok = await page.evaluate(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].filter((x) => x.getAttribute('aria-label') === ${JSON.stringify(label)}).pop(); const b = d && [...d.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(button)}); if (!b) return false; b.click(); return true; })()`);
      if (!ok) throw new Error(`no "${button}" in dialog ${label}`);
      await sleep(400);
    },
    claimBanner: () => page.evaluate(`document.querySelector('[data-claim]')?.innerText ?? ''`),
    claimBannerState: () => page.evaluate(`document.querySelector('[data-claim]')?.getAttribute('data-claim') ?? ''`),
    status: async (missionId) => (await api.get(`/v1/missions/${missionId}`)).mission.status,

    /** A mission on the one-person-step workflow, planned and waiting for its plan approval. */
    async createMission(title) {
      await page.navigate('#/missions/new');
      await page.waitForText('What outcome do you want?', { timeoutMs: 30_000 });
      await sleep(400);
      await page.fill('What outcome do you want?', title);
      await page.fill('Done when', 'The person finishes the step');
      await page.select('Repository', 'acceptance-project');
      await page.select('Workflow', 'Relay person step');
      await page.click('Plan mission …');
      const id = await until(async () => { const h = await page.evaluate('location.hash'); return /#\/missions\/msn_/.test(h) && h.split('/')[2]; }, { label: 'mission page', timeoutMs: 30_000 });
      await until(async () => (await api.get(`/v1/approvals?missionId=${id}&status=PENDING`)).some((v) => v.approval.kind === 'plan'), { label: 'plan approval', timeoutMs: 60_000 });
      return id;
    },

    /**
     * Links a mission to GitHub issue acme/app#<n>, the way issue sync does
     * (an `issue_links` row and `missions.issue_link_id`). Written into the
     * daemon's database directly: how a mission came from an issue is P14's
     * subject, not this one's.
     */
    linkIssue(missionId, number, title = `Issue ${number}`) {
      const db = new DatabaseSync(`${env.home}/tandemise.db`);
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        const repo = db.prepare('SELECT id FROM repositories WHERE workspace_id = ? LIMIT 1').get(env.workspaceId);
        let link = db.prepare('SELECT id FROM issue_links WHERE repository_id = ? AND issue_number = ?').get(repo.id, number);
        if (!link) {
          const id = `iss_relay_${number}_${Date.now().toString(36)}`;
          const now = new Date().toISOString();
          db.prepare(`INSERT INTO issue_links (id, workspace_id, repository_id, github_repo, issue_number, url, title, body, author, state, status, created_at, updated_at)
                      VALUES (?, ?, ?, 'acme/app', ?, ?, ?, '', 'sam', 'open', 'linked', ?, ?)`)
            .run(id, env.workspaceId, repo.id, number, `https://github.com/acme/app/issues/${number}`, title, now, now);
          link = { id };
        }
        db.prepare('UPDATE missions SET issue_link_id = ? WHERE id = ?').run(link.id, missionId);
        return link.id;
      } finally {
        db.close();
      }
    },

    /** Approves the plan in the Inbox the way a person does. */
    async approvePlan(missionId) {
      const mission = (await api.get(`/v1/missions/${missionId}`)).mission;
      await page.navigate('#/inbox');
      await sleep(800);
      await ui.openItem(`Approve the plan for ${mission.title}`, 'For me').catch(async () => ui.openItem(`Approve the plan for ${mission.title}`, 'Everyone'));
      const clicked = await page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => x.offsetParent && !x.closest('[role=dialog]') && x.innerText.trim() === 'Approve'); const el = b[b.length - 1]; if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
      if (!clicked) throw new Error('no Approve button');
      await sleep(800);
    },

    /** Finishes the mission's person step through the API (as "Mark done" would). */
    async finishStep(missionId) {
      const task = await until(async () => (await api.get(`/v1/missions/${missionId}/tasks`)).find((t) => t.status === 'AWAITING_HUMAN'), { label: 'person step waiting', timeoutMs: 30_000 });
      await api.post(`/v1/tasks/${task.id}/complete`, { result: 'Done by hand.' });
      await until(async () => (await w.status(missionId)) === 'COMPLETE', { label: 'mission complete', timeoutMs: 30_000 });
    },
  };
  return w;
}

/** The relay this run started (run-all writes relay.json), or null. */
export function relayInfo(scratch) {
  const f = `${scratch}/relay.json`;
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Starts the relay from this checkout's build on a fixed loopback port (restartable on the same DB and port). */
export function startRelayProcess({ port, db, log }) {
  const out = openSync(log, 'a');
  const child = spawn(process.execPath, [join(repoRoot, 'apps/relay/dist/main.js')], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, RELAY_HOST: '127.0.0.1', RELAY_PORT: String(port), RELAY_DB: db, RELAY_PUBLIC_URL: `http://127.0.0.1:${port}`, RELAY_TEST_CLOCK: '1', RELAY_TEAM_NAME: 'Acceptance team', RELAY_LOG_LEVEL: 'info' },
  });
  child.unref();
  return child.pid;
}

/** Stops the relay this run started, and starts it again on the same DB and port. */
export async function stopRelay(scratch) {
  const info = relayInfo(scratch);
  try { process.kill(info.pid); } catch { /* gone */ }
  await sleep(500);
}

export async function restartRelay(scratch) {
  const info = relayInfo(scratch);
  const pid = startRelayProcess({ port: info.port, db: info.db, log: `${scratch}/relay.log` });
  writeFileSync(`${scratch}/relay.json`, JSON.stringify({ ...info, pid }, null, 2));
  await until(async () => (await fetch(`${info.url}/relay/v1/health`).then((r) => r.ok, () => false)), { label: 'relay back', timeoutMs: 15_000 });
}

/**
 * An observer outside both windows: a second admin made with the relay's own
 * CLI (as \`docker compose exec relay tandemise-relay invite\` would), used to read
 * the relay's truth and to move its test clock. Made once, after r02's import.
 */
export async function observer(scratch) {
  const info = relayInfo(scratch);
  if (info.observerToken) return info;
  const code = execFileSync(process.execPath, [join(repoRoot, 'apps/relay/dist/cli.js'), 'invite', '--role', 'admin', '--name', 'Observer'], { env: { ...process.env, RELAY_DB: info.db, RELAY_LOG_LEVEL: 'error' } }).toString().trim();
  const res = await fetch(`${info.url}/relay/v1/invites/redeem`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tandemise-relay-api': '1' }, body: JSON.stringify({ code, displayName: 'Observer', deviceLabel: 'acceptance' }) });
  const joined = await res.json();
  const next = { ...info, observerToken: joined.deviceToken };
  writeFileSync(`${scratch}/relay.json`, JSON.stringify(next, null, 2));
  return next;
}

export async function relayCall(scratch, method, path, body) {
  const info = await observer(scratch);
  const res = await fetch(`${info.url}${path}`, { method, headers: { authorization: `Bearer ${info.observerToken}`, 'x-tandemise-relay-api': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return res.json().catch(() => null);
}

/** Settings → Team relay: its data-state and text. */
export async function relaySettings(w) {
  await w.page.navigate('#/settings');
  await until(() => w.page.evaluate(`Boolean(document.querySelector('section[aria-label="Team relay"]'))`), { label: 'Team relay section', timeoutMs: 20_000 });
  await w.page.evaluate(`document.querySelector('section[aria-label="Team relay"]').scrollIntoView({ block: 'start' })`);
}

export const relayState = (w) => w.page.evaluate(`document.querySelector('section[aria-label="Team relay"]')?.getAttribute('data-state') ?? ''`);
export const relayText = (w) => w.page.evaluate(`document.querySelector('section[aria-label="Team relay"]')?.innerText ?? ''`);

/** Fills Connect and submits; waits for "connected". */
export async function connectWindow(w, { url, code, name, device }) {
  await relaySettings(w);
  await w.page.click('Connect', { within: 'section[aria-label="Team relay"]' });
  await w.page.fill('Relay address', url);
  await w.page.fill('Invite code', code);
  await w.page.fill('Your name', name);
  await w.page.fill("This computer's name", device);
  await w.page.click('Connect to the relay', { within: 'section[aria-label="Team relay"]' });
  return until(async () => (await relayState(w)) === 'connected', { label: 'connected', timeoutMs: 20_000 }).catch(() => false);
}

/** Facts one scenario leaves for the next (mission ids), next to the run. */
export function readState(scratch) {
  const f = `${scratch}/relay-state.json`;
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
}

export function writeState(scratch, patch) {
  writeFileSync(`${scratch}/relay-state.json`, JSON.stringify({ ...readState(scratch), ...patch }, null, 2));
}
