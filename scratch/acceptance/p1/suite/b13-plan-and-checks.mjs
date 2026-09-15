// B13 — a rejected plan is under Needs you as "Rejected" with Re-plan, and Re-plan asks again.
// B14 — a check addressed to me ("check later") sits under Needs you, decides on the card and leaves.
import { context, writeState } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';

const c = await context();
const { page, api, env, sleep, until } = c;
const cardText = (key) => page.evaluate(`(() => [...document.querySelectorAll('[class*=feedcard]')].filter(e => e.offsetParent && !e.parentElement.closest('[class*=feedcard]')).map(e => e.innerText).find(t => t.includes(${JSON.stringify(key)})) ?? '')()`);
const cardButton = (key, label) => page.evaluate(`(() => { const card = [...document.querySelectorAll('[class*=feedcard]')].find(e => e.offsetParent && e.innerText.includes(${JSON.stringify(key)}) && [...e.querySelectorAll('button')].some(b => b.innerText.trim() === ${JSON.stringify(label)})); const b = card && [...card.querySelectorAll('button')].filter(b => b.innerText.trim() === ${JSON.stringify(label)}).pop(); if (!b) return false; b.click(); return true; })()`);
const needsSection = async () => (await page.text('main')).split(/\nIn progress|\nDone/)[0];

{
  const ev = new Evidence('B13', 'Rejected plan: Needs you, "Rejected", Re-plan asks again');
  await api.patch(`/v1/workspaces/${env.workspaceId}/staffing`, { product: { reviews: [] }, design: { reviews: [] }, architecture: { reviews: [] } });
  const title = `B reject ${Date.now().toString(36)}`;
  const missionId = await c.createMission(title);
  writeState({ b13: missionId });
  const plan = await until(async () => (await c.approvals(missionId, 'PENDING')).find((a) => a.kind === 'plan'), { label: 'plan approval', timeoutMs: 60_000 });
  const reject = plan.options.find((o) => o.id === 'reject') ?? plan.options.find((o) => /reject/i.test(o.label));
  ev.note(`plan options: ${plan.options.map((o) => o.label).join(', ')}`);
  await c.decideInInbox(`Approve the plan for ${title}`, { filter: 'For me', option: reject.label, note: 'Too broad, split the design work first.' });
  const blocked = await until(async () => { const m = (await api.get(`/v1/missions/${missionId}`)).mission; return m.status !== 'AWAITING_PLAN_APPROVAL' && m; }, { label: 'mission leaves plan approval', timeoutMs: 30_000 }).catch(async () => (await api.get(`/v1/missions/${missionId}`)).mission);
  ev.check('the mission is blocked after the rejection', blocked.status === 'BLOCKED', { status: blocked.status, reason: blocked.statusReason });
  await page.navigate(`#/missions/${missionId}`); await sleep(1800);
  const needs = await needsSection();
  const card = await cardText('Plan for');
  ev.check('the plan card is under Needs you', /Needs you/.test(needs) && /Plan for/.test(needs), needs.slice(0, 300));
  ev.check('the plan card says Rejected, not Approved', /Rejected/.test(card) && !/Approved/.test(card), card);
  ev.check('the card offers Re-plan', /Re-plan/.test(card));
  ev.check('the reason has no double period', !/\.\./.test(card) && !/\.\./.test(blocked.statusReason ?? ''), blocked.statusReason);
  await page.screenshot(ev.shot('rejected'));
  ev.check('clicked Re-plan on the card', await cardButton('Plan for', 'Re-plan'));
  await c.confirmIfAsked();
  const again = await until(async () => (await c.approvals(missionId, 'PENDING')).find((a) => a.kind === 'plan' && a.id !== plan.id), { label: 'a new plan approval', timeoutMs: 90_000 }).catch(() => null);
  ev.check('Re-plan produced a new plan to approve', Boolean(again));
  await page.navigate(`#/missions/${missionId}`); await sleep(1800);
  const fresh = await cardText('Plan for');
  ev.check('the card now asks for approval again with an inline Approve', /Approve/.test(fresh) && !/Rejected/.test(fresh), fresh);
  await page.screenshot(ev.shot('replanned'));
  if (again) {
    ev.check('approved the new plan from the card', await cardButton('Plan for', 'Approve'));
    await c.confirmIfAsked();
    const m = await until(async () => { const x = (await api.get(`/v1/missions/${missionId}`)).mission; return x.status === 'EXECUTING' && x; }, { label: 'executing', timeoutMs: 30_000 }).catch(() => null);
    ev.check('the mission runs', Boolean(m));
  }
  ev.save();
  await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: B13 proven' });
}

{
  const ev = new Evidence('B14', 'A check for me: Needs you, decided on the card, then gone');
  const later = [{ by: 'responsible', mode: 'after', when: 'always' }];
  await api.patch(`/v1/workspaces/${env.workspaceId}/staffing`, { product: { reviews: [] }, design: { reviews: [] }, architecture: { reviews: later } });
  const title = `B check ${Date.now().toString(36)}`;
  const missionId = await c.createMission(title);
  writeState({ b14: missionId });
  await c.approvePlan(missionId, title);
  const check = await until(async () => (await c.approvals(missionId, 'PENDING')).find((a) => a.kind === 'check'), { label: 'check for architecture', timeoutMs: 180_000, everyMs: 1500 });
  ev.note(`check "${check.title}" options: ${check.options.map((o) => o.label).join(', ')}`);
  await page.navigate(`#/missions/${missionId}`); await sleep(1800);
  const needs = await needsSection();
  ev.check('the architecture check is under Needs you', /architecture/.test(needs), needs.slice(0, 400));
  const card = await cardText('architecture');
  ev.check('it reads as non-blocking ("Check when you can")', /Check when you can/.test(card), card);
  await page.screenshot(ev.shot('check-needs-you'));
  const ok = check.options.find((o) => o.id !== 'reject') ?? check.options[0];
  ev.check(`decided "${ok.label}" on the card`, await cardButton('architecture', ok.label));
  await c.confirmIfAsked();
  await until(async () => (await api.get(`/v1/approvals/${check.id}`)).approval.status !== 'PENDING', { label: 'check decided', timeoutMs: 20_000 });
  await sleep(1500);
  const after = await needsSection();
  ev.check('the check left Needs you', !/architecture/.test(after), after.slice(0, 300));
  await page.screenshot(ev.shot('check-decided'));
  ev.save();
  await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: B14 proven' });
  // Later scenarios start from no checks on architecture.
  await api.patch(`/v1/workspaces/${env.workspaceId}/staffing`, { architecture: { reviews: [] } });
}
c.close();
