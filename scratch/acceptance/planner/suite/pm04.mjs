import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { context, SCRATCH } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { readState, setRepo } from '../../../fake-gh.mjs';
import { REPO, autoDraft, ghCalls, headerAction, openMission, prs, ship, shipCardText, shot, waitStatus } from '../common.mjs';

const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('PM4', 'A tiny fix with CI green merges on its own');
const merges = () => ghCalls().filter((x) => x.args[0] === 'pr' && x.args[1] === 'merge');
const comments = (n) => readState(`${SCRATCH}/gh`).repos[REPO].comments[String(n)] ?? [];
const factoryDir = join(SCRATCH, 'project', '.tandemise', 'factory');
void readFileSync; void existsSync; void writeFileSync; void setRepo; void sleep; void api; void prs; void merges; void comments; void factoryDir;

try {
  const id = await autoDraft(c, 'fix: typo in the about title');
  ev.note(`mission ${id}`);
  await openMission(c, id);
  await headerAction(c, 'Plan');
  await waitStatus(c, id, ['COMPLETE'], 240_000);
  const view = await ship(c, id);
  const d = view.prs[0]?.decision;
  ev.check('GET /ship: "Merged on its own"', view.headline === 'Merged on its own' && d?.verdict === 'merge', { headline: view.headline, d });
  const call = merges().find((x) => x.args.includes(String(view.prs[0].number)))?.args ?? [];
  ev.check('fake gh saw `pr merge … --squash --match-head-commit <the decided sha>`', call.includes('--squash') && call[call.indexOf('--match-head-commit') + 1] === d.headSha, call.join(' '));
  ev.check('the PR comment says "Tandemise merged this on its own: risk score …"', comments(view.prs[0].number).some((x) => x.body.startsWith('Tandemise merged this on its own: risk score')), comments(view.prs[0].number).map((x) => x.body));
  const card = await shipCardText(c, id, (t) => t.includes('Merged on its own'));
  ev.check('the ship card reads "Merged on its own" with the score, the policy and Revert', card.includes('Merged on its own') && card.includes('Risk score') && card.includes('policy') && card.includes('Revert'), card);
  await shot(c, ev, 'ship-card');
  writeFileSync(join(SCRATCH, 'pm04-mission'), id);
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
}
c.close(); ev.save();
