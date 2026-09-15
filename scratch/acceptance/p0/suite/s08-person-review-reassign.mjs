// A17 — a person's own work goes through its reviews and the lead's sign-off.
// A18 — a task already waiting for one person is handed to another from its "Change" drawer.
import { context, writeState } from '../lib/ctx.mjs';
import { Evidence } from '../lib/evidence.mjs';

const c = await context();
const { page, api, env, ui, sleep, until } = c;
const bo = await c.id('Bo Chen'); const maria = await c.id('Maria Lopez');
const pickState = () => page.evaluate(`Object.fromEntries([...document.querySelectorAll('button.pick')].filter(b=>b.offsetParent).map(b=>[b.innerText.trim().replace(/^\\d+\\s*/,''), b.getAttribute('aria-pressed')]))`);
async function pickOnly(names) {
  for (const [name, state] of Object.entries(await pickState())) {
    const want = names.includes(name);
    if (state !== String(want)) { await page.evaluate(`[...document.querySelectorAll('button.pick')].find(b=>b.offsetParent && b.innerText.trim().replace(/^\\d+\\s*/,'') === ${JSON.stringify(name)})?.click()`); await sleep(250); }
  }
}

const a17 = new Evidence('A17', "A person's own work goes through its review and the lead's sign-off");
// You sign off on work delegated to your reports (Bo reports to you) — toggled in your own drawer.
await page.navigate('#/team'); await sleep(900);
await page.evaluate(`[...document.querySelectorAll('button')].find(x => x.offsetParent && x.innerText.includes('you') && x.innerText.includes('Owner'))?.click()`);
await sleep(700);
if ((await page.evaluate(`(() => { const el = [...document.querySelectorAll('button,[role=switch],input[type=checkbox]')].find(b => b.offsetParent && (b.innerText?.trim() === 'Sign off on delegated work' || b.getAttribute('aria-label') === 'Sign off on delegated work' || b.closest('label')?.innerText.includes('Sign off on delegated work'))); return el ? (el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed') ?? String(el.checked)) : undefined; })()`)) !== 'true') await page.click('Sign off on delegated work');
await page.click('Save');
a17.check('your drawer stores oversight = both_sign_off', Boolean(await until(async () => (await c.team()).find((m) => m.id === c.me && m.oversight === 'both_sign_off'), { label: 'my oversight', timeoutMs: 8000 })));

// Product Manager → a person does it: Bo, then add a review in the Custom editor.
await page.navigate('#/team/staffing'); await sleep(900);
await page.clickIn('Product Manager', 'Edit'); await sleep(700);
await page.select('How this role is staffed', 'A person does it'); await sleep(500);
await page.select('Who', 'Bo Chen'); await sleep(300);
await page.select('How this role is staffed', 'Custom'); await sleep(500);
await page.click('Add review'); await sleep(400);
await page.screenshot(a17.shot('staffing-drawer'));
await page.click('Save'); await sleep(1000);
const product = (await api.get(`/v1/workspaces/${env.workspaceId}/staffing`)).product;
a17.check('product staffed to Bo with a blocking review by the responsible person', JSON.stringify(product.assignees) === JSON.stringify([bo]) && product.reviews?.[0]?.by === 'responsible' && product.reviews?.[0]?.mode === 'blocking', product);

const title = `Person review ${Date.now().toString(36)}`;
const missionId = await c.createMission(title);
writeState({ personReview: missionId });
await c.approvePlan(missionId, title);
const spec = await until(async () => { const t = await c.task(missionId, 'spec'); return t.status === 'AWAITING_HUMAN' && t; }, { label: 'spec waits for Bo', timeoutMs: 60_000 });
a17.check('spec is Bo’s to do', spec.assignee?.id === bo && spec.responsible?.id === bo);
await ui.openTask('spec', title);
await page.select('Done by', 'Bo Chen');
await page.fill('Paste what you produced', 'Spec: the hello page greets visitors by name.');
await page.click('Mark done');
// Bo does not approve his own work; the only card is your sign-off as his lead.
const signOff = await until(async () => { const t = await c.task(missionId, 'spec'); const a = (await c.approvals(missionId, 'PENDING')).filter((x) => x.taskId === t.id && x.kind !== 'check'); return t.status === 'AWAITING_APPROVAL' && a.length && a[0]; }, { label: 'sign-off card', timeoutMs: 20_000 });
a17.check("Bo is not asked to approve his own spec; the card goes to you as his lead", JSON.stringify(signOff.addressees) === JSON.stringify([c.me]), signOff.addressees);
const skipped = (await api.get(`/v1/missions/${missionId}/events?limit=1000`));
a17.check("timeline records that Bo's self-review was skipped", (skipped.events ?? skipped).some((e) => e.body?.type === 'review.skipped' && e.taskId === spec.id));
await ui.openItem('Approve the output of spec?', 'For me');
a17.check('the card is marked "Lead sign-off"', /Lead sign-off/.test(await page.text('main')));
await page.screenshot(a17.shot('sign-off'));
await c.decideInInbox('Approve the output of spec?', { filter: 'For me' });
a17.check('spec succeeds only after your sign-off', Boolean(await until(async () => (await c.task(missionId, 'spec')).status === 'SUCCEEDED', { label: 'spec done', timeoutMs: 20_000 })));
a17.save();

const a18 = new Evidence('A18', 'Hand a waiting task to someone else');
const docs = await until(async () => { const t = await c.task(missionId, 'docs'); return t.status === 'AWAITING_HUMAN' && t; }, { label: 'docs waits', timeoutMs: 60_000 });
a18.check('docs is waiting for Bo', docs.assignee?.id === bo, docs.assignee?.name);
await ui.openTask('docs', title);
await page.click('Change'); await sleep(800);
await page.select('How this role is staffed', 'A person does it'); await sleep(500);
await page.select('Who', 'Maria Lopez'); await sleep(300);
await page.screenshot(a18.shot('change'));
await page.click('Save for this task'); await sleep(1200);
const moved = await until(async () => { const t = await c.task(missionId, 'docs'); return t.assignee?.id === maria && t; }, { label: 'docs reassigned', timeoutMs: 15_000 });
a18.check('docs now waits for Maria, who is responsible', moved.status === 'AWAITING_HUMAN' && moved.responsible?.id === maria && /Waiting for Maria Lopez\.$/.test(moved.statusReason ?? ''), { reason: moved.statusReason });
const everyone = await ui.inbox('Everyone');
a18.check('Inbox shows docs "For Maria Lopez"', /docs[^\n]*\n(?:[^\n]*\n)?\s*For Maria Lopez/.test(everyone));
await page.screenshot(a18.shot('inbox'));
const ranTask = await c.task(missionId, 'spec');
const refused = await api.patch(`/v1/tasks/${ranTask.id}/staffing`, { assignees: [maria] }).then(() => null, (e) => e.status);
a18.check('a task that already ran refuses a staffing change (409)', refused === 409, refused);
await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: A17/A18 proven' });
c.close(); a18.save();
