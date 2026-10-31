// PM5 — a task predicted quick whose change adds db/migrations/0042_add_index.sql: the ship card says "Touches
// db/migrations/0042_add_index.sql — never merged on its own in this project." and fake gh saw no merge.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { autoDraft, ghCalls, headerAction, openMission, ship, shipCardText, shot, waitStatus } from '../common.mjs';

const c = await context();
const { until } = c;
const ev = new Evidence('PM5', 'A change that touches a migration always asks');
const SENTENCE = 'Touches db/migrations/0042_add_index.sql — never merged on its own in this project.';

try {
  const id = await autoDraft(c, 'fix: speed up the user list SCRIPTED_TOUCH=db/migrations/0042_add_index.sql');
  ev.note(`mission ${id}`);
  await openMission(c, id);
  await headerAction(c, 'Plan');
  await waitStatus(c, id, ['EXECUTING'], 60_000);
  const view = await until(async () => { const v = await ship(c, id); return v.prs[0]?.decision != null && v; }, { label: 'decision', timeoutMs: 300_000 });
  const d = view.prs[0].decision;
  ev.check(`the decision asks: "${SENTENCE}"`, d.verdict === 'ask' && d.reasons.includes(SENTENCE), d.reasons);
  const card = await shipCardText(c, id, (t) => t.includes('Touches db/migrations'));
  ev.check('the ship card says so', card.includes(SENTENCE), card);
  await shot(c, ev, 'ship-card');
  ev.check('fake gh saw no pr merge', !ghCalls().some((x) => x.args[0] === 'pr' && x.args[1] === 'merge'));
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
}
c.close(); ev.save();
