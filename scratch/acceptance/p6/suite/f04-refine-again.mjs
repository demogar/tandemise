// F4 — Refining again replaces what is still undecided: the old proposals read "Replaced by a newer proposal", what was accepted stays.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { createDraft, sectionText, rowsOf, clickInRow, refine, cancel } from '../common.mjs';

const c = await context();
const { page, api } = c;
const ev = new Evidence('F4', 'Refine again replaces pending proposals');

const { id: missionId } = await createDraft(c, `F4 hello page ${Date.now().toString(36)}`);
await refine(c, missionId);
await clickInRow(c, 'Proposed criteria', 'P1', 'Accept');
const pressed = await refine(c, missionId);
ev.check('the panel offered "Refine again"', pressed === 'Refine again', pressed);
const earlier = await rowsOf(c, 'Earlier proposals');
ev.check('the two undecided proposals read "Replaced by a newer proposal"', earlier.length === 2 && earlier.every((r) => r.includes('Replaced by a newer proposal')) && earlier[0].startsWith('P2') && earlier[1].startsWith('P3'), earlier);
const proposed = await rowsOf(c, 'Proposed criteria');
ev.check('the new pass is numbered on: P4, P5, P6', proposed.map((r) => r.split(' ')[0]).join(',') === 'P4,P5,P6', proposed);
const done = await rowsOf(c, 'Done when');
ev.check('the accepted criterion stays U1', done.length === 1 && done[0].startsWith('U1'), done);
const questions = await sectionText(c, 'Questions');
ev.check('the unanswered question was replaced by the new pass\'s Q2', questions.includes('Q2') && !questions.includes('Q1 '), questions);
await page.screenshot(ev.shot('replaced-by-newer'));
const view = await api.get(`/v1/missions/${missionId}/refinement`);
ev.check('proof (API): P2, P3 and Q1 are stale', ['P2', 'P3'].every((k) => view.criteria.find((x) => x.key === k)?.status === 'stale') && view.questions.find((q) => q.key === 'Q1')?.status === 'stale', { c: view.criteria.map((x) => [x.key, x.status]), q: view.questions.map((q) => [q.key, q.status]) });

await cancel(c, missionId, 'F4');
c.close(); ev.save();
