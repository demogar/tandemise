// B2 — "Needs you" cards decide inline; B10 — a teammate's pending review is not mine.
import { context, writeState } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';

const c = await context();
const { page, api, env, sleep, until } = c;

// Setup (not under test here): a small team and staffing, as P0 proved through the Team screen.
const person = async (displayName, reportsTo) => {
  const p = await api.post('/v1/people', { displayName });
  const m = await api.post(`/v1/workspaces/${env.workspaceId}/members`, { kind: 'person', personId: (p.person ?? p).id, reportsTo });
  return (m.member ?? m).id;
};
const members = await c.team();
let ana = members.find((m) => m.name === 'Ana Ruiz')?.id;
if (!ana) {
  const maria = await person('Maria Lopez', c.me);
  ana = await person('Ana Ruiz', maria);
}
let figma = members.find((m) => m.name === 'Figma design agent')?.id;
if (!figma) figma = (await api.post(`/v1/workspaces/${env.workspaceId}/members`, { kind: 'agent', name: 'Figma design agent', reportsTo: ana, roleIds: ['design'], runtimeProfileIds: [env.scriptedProfileId] })).id;
const productAgent = members.find((m) => m.name === 'Product agent')?.id ?? (await api.post(`/v1/workspaces/${env.workspaceId}/members`, { kind: 'agent', name: 'Product agent', reportsTo: c.me, roleIds: ['product'], runtimeProfileIds: [env.scriptedProfileId] })).id;
const review = [{ by: 'responsible', mode: 'blocking', when: 'always' }];
await api.patch(`/v1/workspaces/${env.workspaceId}/staffing`, { product: { assignees: [productAgent], reviews: review }, design: { assignees: [figma], reviews: review } });

const title = `B needs ${Date.now().toString(36)}`;
const missionId = await c.createMission(title);
writeState({ b2: missionId });
const b2 = new Evidence('B2', 'Needs you: decide on the card itself');
await until(async () => (await c.approvals(missionId, 'PENDING')).some((a) => a.kind === 'plan'), { label: 'plan approval' });
await page.navigate(`#/missions/${missionId}`); await sleep(1500);
const cardButton = (cardText, label) => page.evaluate(`(() => { const card = [...document.querySelectorAll('[class*=feedcard]')].find(e => e.offsetParent && e.innerText.includes(${JSON.stringify(cardText)}) && [...e.querySelectorAll('button')].some(b => b.innerText.trim() === ${JSON.stringify(label)})); const b = card && [...card.querySelectorAll('button')].filter(b => b.innerText.trim() === ${JSON.stringify(label)}).pop(); if (!b) return false; b.click(); return true; })()`);
b2.check('the plan waits under Needs you with an inline Approve', /Needs you[\s\S]*Plan for[\s\S]*Approve/.test(await page.text('main')));
await page.screenshot(b2.shot('plan-needs-you'));
b2.check('clicked Approve on the plan card', await cardButton('Plan for', 'Approve'));
await c.confirmIfAsked();
await until(async () => (await api.get(`/v1/missions/${missionId}`)).mission.status === 'EXECUTING', { label: 'executing' });

await until(async () => (await c.approvals(missionId, 'PENDING')).some((a) => a.title === 'Approve the output of spec?'), { label: 'spec review', timeoutMs: 90_000 });
await page.navigate(`#/missions/${missionId}`); await sleep(1500);
const needs = await page.text('main');
b2.check('spec review card sits under Needs you with its needs line', /Needs you[\s\S]*spec[\s\S]*Needs[\s\S]*Approve the output of spec\?/.test(needs));
await page.screenshot(b2.shot('spec-needs-you'));
b2.check('approved spec from the card', await cardButton('spec', 'Approve'));
await c.confirmIfAsked();
await until(async () => (await c.task(missionId, 'spec')).status === 'SUCCEEDED', { label: 'spec done' });
await sleep(1500);
const after = await page.text('main');
b2.check('spec moved to Done', /Done[\s\S]*spec/.test(after) && !/Needs you[\s\S]*Approve the output of spec\?/.test(after));
b2.save();

const b10 = new Evidence('B10', "Team: a teammate's pending review is not under my Needs you");
await until(async () => (await c.approvals(missionId, 'PENDING')).some((a) => a.title === 'Approve the output of design?'), { label: 'design review', timeoutMs: 90_000 });
await page.navigate(`#/missions/${missionId}`); await sleep(1500);
const team = await page.text('main');
const needsSection = team.split('In progress')[0] ?? '';
b10.check('design is not in Needs you', !/design/.test(needsSection.replace('Needs you', '')));
b10.check('design is In progress, "Waiting for Ana Ruiz"', /In progress[\s\S]*design[\s\S]*Waiting for Ana Ruiz/.test(team));
await page.screenshot(b10.shot('team-feed'));
b10.save();
await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: B2/B10 proven' });
c.close();
