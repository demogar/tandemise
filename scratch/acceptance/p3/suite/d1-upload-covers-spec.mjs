// D1 — A mission created in the window with an uploaded spec and a Done-when line, planned now. Intake turns
// the upload into a ProductSpec before planning; the (scripted) planner, told the upload covers the spec
// stage, leaves it out and names it under `skipped`; the Plan tab shows "Spec · covered by your upload"
// and no product task. The plan is the planner's own (not the preset fallback), and nothing is staged in SQLite.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { docsSize, ensureTeam, writeState } from '../common.mjs';

const c = await context();
const { page, api, until } = c;
await docsSize(c);
const ev = new Evidence('D1', 'An uploaded spec covers the spec stage of a real plan');
await ensureTeam(c);

const goal = 'A hello page that greets the visitor by name SCRIPTED_PLAN_SKIP';
const spec = [
  '# Hello page',
  '',
  'A page that greets the visitor by name.',
  '',
  '## Acceptance criteria',
  '',
  '- The page shows "Hello, <name>" for a signed-in visitor.',
  '',
].join('\n');

await page.navigate('#/missions/new');
await page.waitForText('What outcome do you want?', { timeoutMs: 30_000 });
await page.fill('What outcome do you want?', goal);
await page.fill('Done when', 'The page greets the visitor by name');
await page.select('Repository', 'acceptance-project');
// No workflow file: the preset, so the planner (not an authored workflow, which never skips) makes the plan.
await page.select('Workflow', 'Feature delivery');
await page.attachFile('.contrib > input[type=file]:nth-of-type(1)', { name: 'hello-spec.md', type: 'text/markdown', text: spec });
const chips = await page.evaluate(`[...document.querySelectorAll('.contrib__chip')].map((x) => x.innerText.trim())`);
ev.check('the New Mission form shows the upload as a chip', chips.length === 1 && chips[0].includes('hello-spec.md'), chips);
await page.evaluate(`document.querySelector('.contrib').scrollIntoView({ block: 'center' })`);
await page.screenshot(ev.shot('new-mission-with-upload'));
await page.click('Plan mission …');
const missionId = await until(async () => { const h = await page.evaluate('location.hash'); return /#\/missions\/msn_/.test(h) && h.split('/')[2]; }, { label: 'mission page', timeoutMs: 30_000 });
writeState({ d1: { missionId } });

const detail = await until(async () => { const d = await api.get(`/v1/missions/${missionId}`); return d.tasks.length > 0 && d; }, { label: 'planned', timeoutMs: 120_000 });
const upload = detail.uploads?.[0];
ev.check('the mission carries the upload, pinned as Evidence', detail.uploads?.length === 1 && upload.filename === 'hello-spec.md', detail.uploads);
const intake = upload?.intakeArtifactId ? (await api.get(`/v1/artifacts/${upload.intakeArtifactId}`)).manifest : null;
ev.check('intake made a ProductSpec from it (mission-wide, not a task\'s)', intake?.type === 'ProductSpec' && intake.taskId === null, intake && { id: intake.id, type: intake.type, taskId: intake.taskId, refs: intake.sourceRefs });

const events = await c.events(missionId);
const seq = (pred) => events.find(pred)?.sequence ?? null;
const intakeAt = seq((e) => e.body.type === 'mission.intake_completed');
const plannedNote = events.find((e) => e.body.type === 'note' && /Planner produced/.test(e.body.text ?? e.body.message ?? ''));
const fallback = events.find((e) => /fell back to the/.test(JSON.stringify(e.body)));
const planAt = plannedNote?.sequence ?? seq((e) => e.body.type === 'mission.planned' || e.body.type === 'plan.proposed');
ev.check('intake ran before planning (mission.intake_completed precedes the plan)', intakeAt !== null && planAt !== null && intakeAt < planAt, { intakeAt, planAt, planned: plannedNote?.body });
ev.check('the plan is the planner\'s, not the preset fallback', plannedNote !== undefined && fallback === undefined, { planned: plannedNote?.body, fallback: fallback?.body });

const covered = detail.tasks.filter((t) => t.status === 'SKIPPED' && t.coveredBy);
ev.check('one SKIPPED placeholder, covered by hello-spec.md, reason "Covered by your upload: hello-spec.md"',
  covered.length === 1 && covered[0].coveredBy.filename === 'hello-spec.md' && covered[0].statusReason === 'Covered by your upload: hello-spec.md' && covered[0].coveredBy.artifactId === intake?.id,
  covered.map((t) => ({ key: t.key, title: t.title, status: t.status, statusReason: t.statusReason, coveredBy: t.coveredBy, outputs: t.expectedOutputs })));
const producers = detail.tasks.filter((t) => !t.coveredBy && (t.roleId === 'product' || t.expectedOutputs.includes('ProductSpec')));
ev.check('no product task: nothing else is on the product role or writes a ProductSpec', producers.length === 0, detail.tasks.map((t) => `${t.key}:${t.roleId}:${t.status}`));
const design = detail.tasks.find((t) => t.key === 'design');
ev.check('the stages that read the spec wait on the placeholder', design?.dependsOn.includes(covered[0]?.key), design?.dependsOn);

await page.navigate(`#/missions/${missionId}/plan`);
const row = await until(async () => { const t = await page.evaluate(`document.querySelector('.taskcard--covered')?.innerText ?? ''`); return t || false; }, { label: 'covered row', timeoutMs: 30_000 }).catch(() => '');
ev.check('the Plan tab shows a muted "… · covered by your upload" row naming hello-spec.md', row.includes('· covered by your upload') && row.includes('hello-spec.md'), row);
ev.check('the covered row reads "Spec · covered by your upload" (spec A2, A8 D1)', row.split('\n')[0].trim() === 'Spec · covered by your upload', row.split('\n')[0]);
ev.check('the covered row has no status dot', await page.evaluate(`Boolean(document.querySelector('.taskcard--covered')) && !document.querySelector('.taskcard--covered .dot')`));
const cards = await page.evaluate(`[...document.querySelectorAll('button.taskcard')].map((b) => b.querySelector('.taskcard__title')?.innerText.trim())`);
ev.check('the Plan tab lists no other spec or product card', cards.filter((t) => /spec|product|problem/i.test(t ?? '') && !/covered by your upload/.test(t ?? '')).length === 0, cards);
await page.screenshot(ev.shot('plan-covered-row'));
ev.note(`plan cards: ${JSON.stringify(cards)}`);

await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: D1 proven' }).catch(() => undefined);
c.close(); ev.save();
