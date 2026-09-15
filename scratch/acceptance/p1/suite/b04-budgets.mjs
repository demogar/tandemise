// B4 tighten pass, B5 still too long, B6 missing handoff, B7 superseded hidden.
// Modes are switched per mission through the goal text, which the scripted agent reads from its prompt.
import { context, writeState } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';

const c = await context();
const { page, api, env, ui, sleep, until } = c;
// Keep this scenario about budgets: no reviews in the way.
await api.patch(`/v1/workspaces/${env.workspaceId}/staffing`, { product: { reviews: [] }, design: { reviews: [] } });

async function runUntilDesign(mode) {
  const title = `B ${mode} ${Date.now().toString(36)}`;
  const missionId = await c.createMission(`${title} ${mode}`);
  await c.approvePlan(missionId, `${title} ${mode}`);
  const design = await until(async () => { const t = await c.task(missionId, 'design'); return ['SUCCEEDED', 'AWAITING_APPROVAL', 'BLOCKED', 'FAILED'].includes(t.status) && t; }, { label: `design (${mode})`, timeoutMs: 180_000, everyMs: 1500 });
  const events = await api.get(`/v1/missions/${missionId}/events?limit=1000`);
  return { missionId, design, events: (events.events ?? events).filter((e) => e.taskId === design.id) };
}

{
  const ev = new Evidence('B4', 'Too long first draft → one tighten pass → short');
  const { missionId, design, events } = await runUntilDesign('SCRIPTED_LONG');
  writeState({ b4: missionId });
  const tightens = events.filter((e) => e.body?.type === 'artifact.tighten_requested');
  ev.check('exactly one tighten pass', tightens.length === 1, tightens.length);
  ev.check('design succeeded without spending an attempt', design.status === 'SUCCEEDED' && design.attempts === 1, { status: design.status, attempts: design.attempts });
  const art = (await api.get(`/v1/missions/${missionId}/artifacts`)).find((a) => a.taskId === design.id && a.type === 'DesignBrief');
  ev.check('the kept artifact is within budget', art && art.overBudget === false, { words: art?.wordCount, overBudget: art?.overBudget });
  // B3 (appendix half): the tightened doc moved detail under "## Appendix"; the reader keeps it collapsed.
  const b3a = new Evidence('B3a', 'Full doc: the appendix is collapsed with its word count');
  await page.navigate(`#/missions/${missionId}`); await sleep(1500);
  await page.evaluate(`(() => { const card = [...document.querySelectorAll('[class*=feedcard]')].find(e => e.innerText.includes('design') && e.innerText.includes('Full doc')); [...card.querySelectorAll('button,a')].find(b => b.innerText.trim().startsWith('Full doc'))?.click(); })()`);
  await sleep(1500);
  const appendix = await page.evaluate(`(() => { const d = [...document.querySelectorAll('details')].find(x => x.offsetParent && /Appendix/.test(x.querySelector('summary')?.innerText ?? '')); return d ? { summary: d.querySelector('summary').innerText.trim(), open: d.open } : null; })()`);
  b3a.check('an "Appendix (N words)" section exists and starts collapsed', appendix && /Appendix \(\d+ words\)/.test(appendix.summary) && appendix.open === false, appendix);
  await page.screenshot(b3a.shot('reader-appendix'));
  b3a.save();
  await page.evaluate(`document.querySelector('[aria-label=Close], button[title=Close]')?.click()`);

  await page.navigate(`#/missions/${missionId}/timeline`); await sleep(1500);
  ev.check('timeline shows the tighten request', /tighten/i.test(await page.text('main')));
  await page.screenshot(ev.shot('timeline'));
  ev.save();

  const b7 = new Evidence('B7', 'Superseded versions are hidden until asked for');
  await page.navigate(`#/missions/${missionId}/artifacts`); await sleep(1500);
  const list = await page.text('main');
  const designRows = (list.match(/DesignBrief ready for the hello page/g) ?? []).length;
  b7.check('one DesignBrief row by default', designRows === 1, designRows);
  await page.evaluate(`[...document.querySelectorAll('button,[role=switch],label')].find(b => b.offsetParent && /Show older versions/.test(b.innerText || b.getAttribute('aria-label') || ''))?.click()`);
  await sleep(800);
  const older = await page.text('main');
  b7.check('"Show older versions" reveals v1 under the live version', /v1/.test(older) && /v2/.test(older));
  await page.screenshot(b7.shot('older'));
  b7.save();
  await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance' });
}

{
  const ev = new Evidence('B5', 'Still too long after tightening → accepted, flagged, mission continues');
  const { missionId, design, events } = await runUntilDesign('SCRIPTED_STUBBORN');
  ev.check('one tighten pass, then an over_budget event', events.filter((e) => e.body?.type === 'artifact.tighten_requested').length === 1 && events.some((e) => e.body?.type === 'artifact.over_budget'));
  ev.check('design still succeeded', design.status === 'SUCCEEDED', design.status);
  await page.navigate(`#/missions/${missionId}`); await sleep(1800);
  const feed = await page.text('main');
  ev.check('the design card shows an "Over budget" marker', /design[\s\S]{0,300}Over budget|Over budget[\s\S]{0,300}design/i.test(feed));
  await page.screenshot(ev.shot('card'));
  const next = await until(async () => { const t = await c.task(missionId, 'build'); return t.status !== 'PENDING' && t; }, { label: 'build started', timeoutMs: 90_000 });
  ev.check('the mission kept going', ['READY', 'RUNNING', 'SUCCEEDED'].includes(next.status), next.status);
  ev.save();
  await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance' });
}

{
  const ev = new Evidence('B6', 'A missing handoff is named in the retry and then fixed');
  const { missionId, design } = await runUntilDesign('SCRIPTED_NO_HANDOFF_ONCE');
  const runs = await api.get(`/v1/missions/${missionId}/events?limit=1000`);
  const all = (runs.events ?? runs).filter((e) => e.taskId === design.id);
  const feedbackText = JSON.stringify(all.map((e) => e.body)) + JSON.stringify(design.retryFeedback ?? '');
  ev.check('the retry named handoff.headline', /handoff\.headline/.test(feedbackText));
  ev.check('the next attempt succeeded', design.status === 'SUCCEEDED' && design.attempts === 2, { status: design.status, attempts: design.attempts });
  ev.save();
  await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance' });
}
c.close();
