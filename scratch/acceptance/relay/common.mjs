// Shared by the relay scenarios: one or two real windows (each with its own
// home and daemon from this checkout), issue-linked missions, and the relay
// started from apps/relay/dist.
import { readFileSync, existsSync } from 'node:fs';
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
