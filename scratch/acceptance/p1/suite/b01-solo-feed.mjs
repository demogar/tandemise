// B1, B3, B8, B9, B12 — a solo mission read through the Feed: short cards, a readable full doc,
// a person's headline derived from their text, a preview link, and a DOM readability audit.
import { context, writeState } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';

const c = await context();
const { page, api, ui, sleep, until } = c;
const title = `B solo ${Date.now().toString(36)}`;
const missionId = await c.createMission(title);
writeState({ b1: missionId });

const b1 = new Evidence('B1', 'Solo mission opens on a feed of short cards');
await until(async () => (await c.approvals(missionId, 'PENDING')).some((a) => a.kind === 'plan'), { label: 'plan approval' });
await page.navigate(`#/missions/${missionId}`); await sleep(1500);
const first = await page.text('main');
b1.check('the mission opens on the Feed tab', /Needs you/.test(first) && (await page.evaluate(`[...document.querySelectorAll('[role=tab],.tabs button,.tabs a')].find(t => /active|selected/.test(t.className) || t.getAttribute('aria-selected') === 'true')?.innerText ?? ''`)).startsWith('Feed'));
await page.screenshot(b1.shot('needs-plan'));
await c.approvePlan(missionId, title);

// My own docs step: do it from the Feed.
await until(async () => (await c.task(missionId, 'docs')).status === 'AWAITING_HUMAN', { label: 'docs waiting', timeoutMs: 120_000 });
await page.navigate(`#/missions/${missionId}`); await sleep(1500);
await c.page.evaluate(`(() => { const card = [...document.querySelectorAll('article,[class*=feedcard]')].find(e => e.innerText.includes('docs') && e.innerText.includes('Do it')); [...(card?.querySelectorAll('button') ?? [])].find(b => b.innerText.trim().startsWith('Do it'))?.click(); })()`);
await sleep(900);
await page.fill('Paste what you produced', 'The hello page greets each visitor by name. Guests see a friendly welcome instead. Nothing else changes.');
await page.click('Mark done');

const mission = await until(async () => { const m = (await api.get(`/v1/missions/${missionId}`)).mission; return ['COMPLETE', 'BLOCKED', 'FAILED'].includes(m.status) && m; }, { label: 'mission end', timeoutMs: 300_000, everyMs: 2000 });
b1.check('mission completes', mission.status === 'COMPLETE', mission.status);
await page.navigate(`#/missions/${missionId}`); await sleep(1800);
// Done lists the latest five; which tasks those are depends on finishing order, so show them all.
await page.evaluate(`[...document.querySelectorAll('button')].find(b => /^Show \\d+ more$/.test(b.innerText.trim()))?.click()`);
await sleep(1200);
const feedText = await page.text('main');
b1.check('Done cards show headlines, not YAML or ids', /ready for the hello page/.test(feedText) && !/schemaVersion|^type: |---/m.test(feedText) && !/\b(art|tsk|apr)_[a-z0-9]{12,}/.test(feedText));
b1.check('cards carry "by … · responsible You"', /responsible\s*You/.test(feedText));
await page.screenshot(b1.shot('done'));
b1.save();

const b8 = new Evidence('B8', "A person's output gets a headline from their own first sentence");
b8.check('docs card headline is the first sentence of the text', /The hello page greets each visitor by name\./.test(feedText) && !/Guests see a friendly welcome/.test(feedText.split('docs')[1]?.split('Full doc')[0] ?? ''));
b8.save();

const b9 = new Evidence('B9', 'A preview link renders on the card');
b9.check('design card shows "Open preview ↗"', /Open preview/.test(feedText));
b9.save();

const b12 = new Evidence('B12', 'Readability audit of done cards (DOM)');
const audit = await page.evaluate(`(() => {
  const cards = [...document.querySelectorAll('[class*=feedcard]')].filter(e => e.offsetParent && /Done|Approved|Auto-approved/.test(e.innerText) && !e.parentElement.closest('[class*=feedcard]'));
  const lineHeight = (el) => parseFloat(getComputedStyle(el).lineHeight) || 20;
  return cards.map((card) => {
    let lines = 0;
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    const blocks = new Set();
    while (walker.nextNode()) { const p = walker.currentNode.parentElement; if (p && walker.currentNode.textContent.trim()) blocks.add(p.closest('p,li,div,h3,h4,span') ?? p); }
    const tops = new Set();
    for (const b of blocks) for (const r of b.getClientRects()) { if (r.height > 0) tops.add(Math.round(r.top / 4)); }
    lines = tops.size;
    const headline = card.querySelector('[class*=headline]')?.innerText ?? '';
    const points = [...card.querySelectorAll('li')].map(l => l.innerText).join('');
    return { lines, chars: headline.length + points.length, text: card.innerText.split('\\n')[0] };
  });
})()`);
b12.note(JSON.stringify(audit));
b12.check('every done card fits in ≤ 8 visible lines', audit.length > 0 && audit.every((a) => a.lines <= 8), audit.map((a) => a.lines));
b12.check('headline + points ≤ the contract maximum (510 chars)', audit.every((a) => a.chars <= 510), audit.map((a) => a.chars));
b12.save();

// B3: the full doc of the design card.
const b3 = new Evidence('B3', 'Full doc: no front matter, handoff first, appendix collapsed');
await page.evaluate(`(() => { const card = [...document.querySelectorAll('[class*=feedcard]')].find(e => e.innerText.includes('design') && e.innerText.includes('Full doc')); [...card.querySelectorAll('button,a')].find(b => b.innerText.trim().startsWith('Full doc'))?.click(); })()`);
await sleep(1200);
const drawer = await page.text('body');
b3.check('reader shows the headline and points', /DesignBrief ready for the hello page/.test(drawer));
b3.check('no YAML front matter in the reader', !/schemaVersion|headline:|^type: DesignBrief/m.test(drawer));
b3.check('ids live behind Details, not in the header text', !/\bart_[a-z0-9]{12,}/.test(drawer.split('Details')[0] ?? drawer));
await page.screenshot(b3.shot('reader'));
b3.save();
c.close();
