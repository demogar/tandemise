// Shared by the P3 scenarios: the team on the scripted runtime, the feed-card gestures for
// "Continue elsewhere" and "Hand back", and the files the pickers are given.
import { readFileSync, writeFileSync } from 'node:fs';
import { SCRATCH, readState, writeState } from '../p0/lib/ctx.mjs';
import { agent, waitTask } from '../p2/common.mjs';

export { readState, writeState, waitTask, SCRATCH };

/** The one pull request the fake `gh` knows (fake-gh.mjs), written by D3. */
export const GH_STATE = `${SCRATCH}/gh-pr.json`;
export const writeGhState = (pr) => writeFileSync(GH_STATE, JSON.stringify(pr, null, 2));
export const ghCalls = () => { try { return readFileSync(`${GH_STATE}.calls`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

/** 1360×900, the size the docs screenshots are taken at. */
export async function docsSize(c) {
  await c.page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.sleep(300);
}

/** You plus an agent per role the P3 workflows use, each on the scripted runtime. Idempotent. */
export async function ensureTeam(c) {
  const profile = c.env.scriptedProfileId;
  const product = await agent(c, 'Product agent', ['product'], profile);
  const designer = await agent(c, 'Design agent', ['design'], profile);
  const coder = await agent(c, 'Coding agent', ['development'], profile);
  const reviewer = await agent(c, 'Review agent', ['review'], profile);
  await c.staff({
    product: { assignees: [product], reviews: [] },
    design: { assignees: [designer], reviews: [] },
    development: { assignees: [coder], reviews: [] },
    review: { assignees: [reviewer], reviews: [] },
  });
  return { product, designer, coder, reviewer };
}

/** A mission on a workflow file, planned and approved in the window, the way P2's scenarios start one. */
export async function startMission(c, goal, workflow) {
  const missionId = await c.createMission(goal, { workflow });
  await c.approvePlan(missionId, goal);
  return missionId;
}

/** The feed card for a task key, as the window shows it now. */
export const card = (c, key) => c.cardText(key);

export async function openFeed(c, missionId) {
  await c.page.navigate(`#/missions/${missionId}`);
  await c.sleep(1200);
}

/** Clicks the button whose text starts with `label` on the feed card for `key`. */
export async function clickOnCard(c, key, label) {
  const ok = await c.until(() => c.page.evaluate(`(() => {
    const card = document.querySelector('[data-feed-card=${JSON.stringify(key)}]');
    const b = card && [...card.querySelectorAll('button')].find((x) => x.offsetParent && !x.disabled && x.innerText.trim().startsWith(${JSON.stringify(label)}));
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    b.click();
    return true;
  })()`), { label: `"${label}" on the ${key} card`, timeoutMs: 20_000, everyMs: 400 });
  await c.sleep(500);
  return ok;
}

/** Clicks an enabled button with exactly this text in the topmost dialog. */
export async function clickInDialog(c, text) {
  const ok = await c.page.evaluate(`(() => {
    const d = [...document.querySelectorAll('[role=dialog]')].pop();
    const b = d && [...d.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(text)} && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!ok) throw new Error(`no enabled "${text}" button in the open dialog`);
  await c.sleep(400);
}

/** Sets the value of the topmost dialog's field whose label starts with `label`. */
export async function fillInDialog(c, label, value) {
  const ok = await c.page.evaluate(`(() => {
    const d = [...document.querySelectorAll('[role=dialog]')].pop();
    const l = d && [...d.querySelectorAll('label')].find((x) => x.innerText.trim().startsWith(${JSON.stringify(label)}));
    const el = l?.querySelector('input,textarea') ?? (d && [...d.querySelectorAll('input,textarea')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(label)}));
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (!ok) throw new Error(`no "${label}" field in the open dialog`);
  await c.sleep(250);
}

/** "Continue elsewhere" on a card, in the window: the dialog, the tool, the button. Returns the dialog's text. */
export async function continueElsewhere(c, missionId, key, tool, { shot } = {}) {
  await openFeed(c, missionId);
  await clickOnCard(c, key, 'Continue elsewhere');
  const text = await c.until(() => c.dialogText('Continue '), { label: 'Continue elsewhere dialog', timeoutMs: 10_000 });
  const prefilled = await c.page.evaluate(`[...document.querySelectorAll('[role=dialog] input')].pop()?.value ?? ''`);
  if (tool !== undefined && tool !== prefilled) await fillInDialog(c, 'Where you will work on it', tool);
  if (shot) await c.page.screenshot(shot);
  await clickInDialog(c, 'Continue elsewhere');
  const parked = await waitTask(c, missionId, key, (t) => t.parkedExternal != null, `${key} parked`, 30_000);
  return { dialog: text, prefilled, parked };
}

/** Opens "Hand back" on a parked card and types the note. */
export async function openHandBack(c, missionId, key, note) {
  await openFeed(c, missionId);
  await clickOnCard(c, key, 'Hand back');
  await c.until(() => c.dialogText('Hand back '), { label: 'Hand back dialog', timeoutMs: 10_000 });
  const tool = (await c.task(missionId, key)).parkedExternal.tool;
  await fillInDialog(c, `What did you do in ${tool}?`, note);
}

/** The topmost dialog's picker: its file input (first) and the link's export input (second). */
export const DIALOG_FILE = '[role=dialog] .contrib > input[type=file]:nth-of-type(1)';
export const DIALOG_EXPORT = '[role=dialog] .contrib > input[type=file]:nth-of-type(2)';

/** In the open picker: "Add link", the URL, optionally "Attach an export" with a file, then "Add". */
export async function addLinkInDialog(c, url, exported) {
  await c.page.click('Add link', { within: '[role=dialog]' });
  await fillInDialog(c, 'Link', url);
  if (exported) await c.page.attachFile(DIALOG_EXPORT, exported);
  await c.page.click('Add', { within: '[role=dialog]' });
}

/** The artifact's refs as `kind=value` strings, for evidence. */
export const refs = (a) => (a?.sourceRefs ?? []).map((r) => `${r.kind}=${r.value}`);
