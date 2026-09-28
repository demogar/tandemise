// Shared by the P3b evals harnesses (run-all.mjs's scenarios and ui-shots.mjs): the runtime switched to
// NDJSON with a --model flag, the development role's model, eval-run polling, and the window gestures the
// Evals screen needs (its query lives in location.search, beside the hash route).
import { SCRATCH, readState, writeState } from '../p0/lib/ctx.mjs';

export { SCRATCH, readState, writeState };

/** The workflow E1's missions run: a design, then a gated build that reads it (p0/workflows/p3b-evals.yaml). */
export const WORKFLOW = 'P3b evals';
export const TERMINAL = ['completed', 'stopped_at_cap', 'failed', 'cancelled'];

/** 1360×900, the size the docs screenshots are taken at. */
export async function docsSize(c) {
  await c.page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.sleep(300);
}

/**
 * The acceptance runtime (p0/setup.mjs) prints text and takes no model flag. Evals measure cost and pin a
 * model, so the scripted runtime is switched to NDJSON (it then reports usage) with `--model <name>`.
 */
export async function measuredRuntime(c) {
  const { api, env } = c;
  const profile = (await api.get(`/v1/runtimes?workspaceId=${env.workspaceId}`)).map((p) => p.profile ?? p).find((p) => p.id === env.scriptedProfileId);
  if (profile.settings.outputFormat === 'ndjson' && profile.settings.modelFlag === '--model') return profile.settings;
  await api.patch(`/v1/runtimes/${env.scriptedProfileId}`, { settings: { ...profile.settings, outputFormat: 'ndjson', modelFlag: '--model' } });
  return (await api.get(`/v1/runtimes?workspaceId=${env.workspaceId}`)).map((p) => p.profile ?? p).find((p) => p.id === env.scriptedProfileId).settings;
}

/** A role as the daemon has it now. */
export const role = async (c, id = 'development') => (await c.api.get(`/v1/roles?workspaceId=${c.env.workspaceId}`)).find((r) => r.id === id);

/** Replaces a role with itself plus `patch`. */
export async function putRole(c, patch, id = 'development') {
  const { createdAt, updatedAt, builtIn, workspaceId, ...rest } = await role(c, id);
  return c.api.put(`/v1/roles/${id}`, { ...rest, workspaceId: c.env.workspaceId, ...patch });
}

/** The development role on one model, with no escalation and no economy model. */
export const developerOn = (c, model) => putRole(c, { models: { model, escalate: [], economyModel: null } });

/** An agent member on the scripted runtime, created once. */
export async function agent(c, name, roleIds) {
  const existing = (await c.team()).find((m) => m.name === name);
  if (existing) return existing.id;
  return (await c.api.post(`/v1/workspaces/${c.env.workspaceId}/members`, { kind: 'agent', name, reportsTo: c.me, roleIds, runtimeProfileIds: [c.env.scriptedProfileId] })).id;
}

export const evalRun = (c, id) => c.api.get(`/v1/evals/runs/${id}`);
export const waitRun = (c, id, timeoutMs = 300_000) =>
  c.until(async () => { const r = await evalRun(c, id); return TERMINAL.includes(r.status) && r; }, { label: `eval run ${id} ends`, timeoutMs, everyMs: 1000 });

/** The Evals screen's Runs tab on a suite (and a run). */
export const runsHash = (suite, run) => `#/evals?tab=runs&suite=${suite}${run ? `&run=${run}` : ''}`;

/**
 * The window gestures, bound to one context:
 * - `go(hash)`: the app routes on the hash and keeps its query in location.search (wouter's hash
 *   navigation), so a query goes where the app's own links put it, and the hashchange tells the router.
 * - `press(label, within)`: clicks an enabled, visible button (or link) whose text is exactly `label`.
 * - `has(needle, selector)` / `waitFor(needle, selector, timeoutMs)`: text on the screen.
 * - `reload()`: a fresh read after the daemon was changed behind the window's back.
 */
export function windowOf(c) {
  const { page, sleep } = c;
  const go = async (hash) => {
    const [path, query = ''] = hash.replace(/^#/, '').split('?');
    await page.evaluate(`(() => {
      const url = new URL(location.href);
      url.search = ${JSON.stringify(query)};
      url.hash = ${JSON.stringify(path)};
      history.pushState(null, '', url.href);
      dispatchEvent(new HashChangeEvent('hashchange'));
    })()`);
    await sleep(900);
  };
  const press = async (label, within = 'main') => {
    const ok = await c.until(() => page.evaluate(`(() => {
      const root = [...document.querySelectorAll(${JSON.stringify(within)})].pop() ?? document.body;
      const b = [...root.querySelectorAll('button, a')].find((x) => x.offsetParent !== null && !x.disabled && (x.innerText || x.getAttribute('aria-label') || '').trim() === ${JSON.stringify(label)});
      if (!b) return false;
      b.scrollIntoView({ block: 'center' });
      b.click();
      return true;
    })()`), { label: `button "${label}"`, timeoutMs: 20_000, everyMs: 300 });
    await sleep(500);
    return ok;
  };
  const has = (needle, selector = 'main') => page.evaluate(`(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '').includes(${JSON.stringify(needle)})`);
  const waitFor = (needle, selector = 'main', timeoutMs = 30_000) => page.waitForText(needle, { selector, timeoutMs });
  const reload = async () => {
    await page.evaluate('location.reload()');
    await sleep(1500);
    await page.waitForText('Daemon connected', { timeoutMs: 60_000 });
  };
  /** A row of the scorecard's whole-suite table: [measure, baseline, candidate, difference]. */
  const scoreRow = (measure, table = 'Whole suite') => page.evaluate(`[...(document.querySelector('[aria-label=${JSON.stringify(table)}] tr[aria-label=${JSON.stringify(measure)}]')?.querySelectorAll('td') ?? [])].map((td) => td.innerText.trim())`);
  return { go, press, has, waitFor, reload, scoreRow };
}
