import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { context, SCRATCH } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { readState, setRepo } from '../../../fake-gh.mjs';
import { REPO, autoDraft, ghCalls, headerAction, openMission, prs, ship, shipCardText, shot, waitStatus } from '../common.mjs';

const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('PM8', 'A push after the decision voids it and decides again');
const merges = () => ghCalls().filter((x) => x.args[0] === 'pr' && x.args[1] === 'merge');
const comments = (n) => readState(`${SCRATCH}/gh`).repos[REPO].comments[String(n)] ?? [];
const factoryDir = join(SCRATCH, 'project', '.tandemise', 'factory');
void readFileSync; void existsSync; void writeFileSync; void setRepo; void sleep; void api; void prs; void merges; void comments; void factoryDir;

try {
  setRepo(`${SCRATCH}/gh`, REPO, { moveHeadOnMerge: 'd'.repeat(40) });
  const id = await autoDraft(c, 'fix: typo in the help title');
  ev.note(`mission ${id}`);
  await openMission(c, id);
  await headerAction(c, 'Plan');
  const rows = await until(async () => { const r = c.sql('SELECT head_sha AS headSha, voided_at AS voidedAt, verdict FROM merge_decisions WHERE mission_id = ? ORDER BY decided_at', id); return r.length >= 2 && r; }, { label: 'second decision', timeoutMs: 240_000 });
  ev.check('the first decision was voided', rows[0].voidedAt !== null, rows);
  ev.check('…and a new one made on the new sha', rows[1].headSha === 'd'.repeat(40), rows);
  const events = await c.events(id);
  ev.check('the feed says "The pull request changed after it was checked; checking again."', events.some((e) => e.body?.type === 'note' && e.body.text === 'The pull request changed after it was checked; checking again.'), events.filter((e) => e.body?.type === 'note').map((e) => e.body.text).slice(-5));
  const first = merges().filter((x) => x.args.includes('--match-head-commit')).at(-1).args;
  ev.check('the refused merge was bound to the first decision\'s sha', first[first.indexOf('--match-head-commit') + 1] === rows[0].headSha, first.join(' '));
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
}
c.close(); ev.save();
