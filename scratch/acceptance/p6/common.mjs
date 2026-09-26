// Shared by the P6 scenarios: a draft created from the window with no Done-when
// line, and reading the "Get it ready" panel and the gated Plan button.

/** New mission from the window with the goal only: the button reads "Create and refine", nothing is planned. */
export async function createDraft(c, goal, { autonomy } = {}) {
  const { page, sleep, until } = c;
  await page.navigate('#/missions/new');
  await page.waitForText('What outcome do you want?', { timeoutMs: 30_000 });
  await sleep(400);
  await page.fill('What outcome do you want?', goal);
  await page.select('Repository', 'acceptance-project');
  if (autonomy) await page.click(autonomy);
  const label = await page.evaluate(`document.querySelector('.topbar__actions .btn--primary')?.innerText.trim() ?? ''`);
  const clicked = await page.evaluate(`(() => { const b = [...document.querySelectorAll('.topbar__actions button')].find((x) => x.innerText.trim().startsWith('Create and refine') && !x.disabled); if (!b) return false; b.click(); return true; })()`);
  if (!clicked) throw new Error(`no enabled "Create and refine" button (header reads "${label}")`);
  const id = await until(async () => { const h = await page.evaluate('location.hash'); return /#\/missions\/msn_/.test(h) && h.split('/')[2]; }, { label: 'mission page', timeoutMs: 30_000 });
  await page.waitForText('Get it ready', { timeoutMs: 30_000 });
  return { id, createLabel: label };
}

/** A section of the panel by its aria-label ("Get it ready", "Proposed criteria", "Questions", "Done when", "Earlier proposals"). */
export const sectionText = (c, label) => c.page.evaluate(`document.querySelector('section[aria-label=${JSON.stringify(label)}]')?.innerText ?? ''`);

/** Each row of a panel section, as one line of visible text. */
export const rowsOf = (c, label) => c.page.evaluate(`[...document.querySelectorAll('section[aria-label=${JSON.stringify(label)}] .list__row')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())`);

/** The header's primary action: the Plan button on a draft. */
export const planButton = (c) => c.page.evaluate(`(() => { const b = document.querySelector('.topbar__actions .btn--primary'); return b ? { text: b.innerText.trim(), disabled: b.disabled } : null; })()`);

/** Clicks `button` in the row of `section` whose key reads `key`. */
export async function clickInRow(c, section, key, button) {
  const ok = await c.page.evaluate(`(() => {
    const row = [...document.querySelectorAll('section[aria-label=${JSON.stringify(section)}] .list__row')].find((r) => r.querySelector('.mono')?.innerText.trim() === ${JSON.stringify(key)});
    const b = row && [...row.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(button)} && !x.disabled);
    if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true;
  })()`);
  if (!ok) throw new Error(`no "${button}" in ${section} row ${key}`);
  await c.sleep(700);
}

/** Presses Refine (or Refine again) and waits for the pass to land. */
export async function refine(c, missionId) {
  const { page, api, until, sleep } = c;
  const label = (await page.evaluate(`[...document.querySelectorAll('section[aria-label="Get it ready"] button')].map((b) => b.innerText.trim())`)).find((t) => t === 'Refine' || t === 'Refine again');
  if (!label) throw new Error('no Refine button');
  await page.click(label, { within: 'section[aria-label="Get it ready"]' });
  await until(async () => (await api.get(`/v1/missions/${missionId}/refinement`)).state !== 'running', { label: 'refinement settled', timeoutMs: 120_000, everyMs: 700 });
  await sleep(1500);
  return label;
}

/** Answers the open question `key` by clicking `option`, then Answer. */
export async function answerWithOption(c, key, option) {
  const ok = await c.page.evaluate(`(() => {
    const q = document.querySelector('[aria-label=${JSON.stringify(`Question ${key}`)}]');
    const o = q && [...q.querySelectorAll('button.option')].find((b) => b.innerText.trim() === ${JSON.stringify(option)});
    if (!o) return false; o.click(); return true;
  })()`);
  if (!ok) throw new Error(`no option "${option}" on ${key}`);
  await c.sleep(400);
  const sent = await c.page.evaluate(`(() => {
    const q = document.querySelector('[aria-label=${JSON.stringify(`Question ${key}`)}]');
    const b = q && [...q.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Answer' && !x.disabled);
    if (!b) return false; b.click(); return true;
  })()`);
  if (!sent) throw new Error(`no enabled Answer on ${key}`);
  await c.sleep(800);
}

export async function cancel(c, missionId, id) {
  await c.api.post(`/v1/missions/${missionId}/cancel`, { reason: `acceptance: ${id} proven` }).catch(() => undefined);
}
