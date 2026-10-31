// PM1 on the real runtime (run-all --real-claude): a tiny fix, planned in the quick lane, is done by Claude Code
// and goes end to end to a pull request — pushed to the local bare origin, opened through the fake gh.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { context, SCRATCH } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { REPO, autoDraft, ghCalls, headerAction, openMission, prs, ship, shipCardText, shot, whyText } from '../common.mjs';

const c = await context();
const { api, until, env } = c;
const ev = new Evidence('PM1R', 'Real runtime: Claude Code does a quick-lane fix and the factory opens its pull request');
const project = join(SCRATCH, 'project');
const git = (...args) => execFileSync('git', ['-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@example.invalid', ...args], { cwd: project, encoding: 'utf8' }).trim();

writeFileSync(join(project, 'README.md'), '# Acceptence project\n\nA small project the acceptance suite works in.\n');
git('fetch', '-q', 'origin', 'main');
git('checkout', '-q', '-f', '-B', 'main', 'origin/main');
writeFileSync(join(project, 'README.md'), '# Acceptence project\n\nA small project the acceptance suite works in.\n');
git('commit', '-q', '-am', 'docs: readme');
git('push', '-q', 'origin', 'main');

let claude = (await api.get('/v1/runtimes')).map((r) => r.profile ?? r).find((p) => p.adapterId === 'claude-code');
if (!claude) {
  claude = await api.post('/v1/runtimes', { adapterId: 'claude-code', name: 'Claude Code', workspaceId: null, executablePath: `${process.env.HOME}/.local/bin/claude`, settings: process.env.ACCEPTANCE_CLAUDE_CONFIG_DIR ? { configDir: process.env.ACCEPTANCE_CLAUDE_CONFIG_DIR } : {}, maxConcurrent: 1, enabled: true });
  claude = claude.profile ?? claude;
}
const routing = (await api.get(`/v1/workspaces/${env.workspaceId}`)).workspace.routing ?? {};
// Every role that can do a quick-lane step goes to Claude Code for this scenario.
await api.patch(`/v1/workspaces/${env.workspaceId}`, { routing: Object.fromEntries([...Object.keys(routing), 'development', 'qa', 'product'].map((k) => [k, [claude.id]])) });

try {
  const id = await autoDraft(c, 'fix: typo in the README title ("Acceptence" should be "Acceptance")');
  ev.note(`mission ${id}`);
  await openMission(c, id);
  await headerAction(c, 'Plan');
  const why = await whyText(c, id, (t) => t.includes('Quick lane'));
  ev.check('planned in the quick lane', why.includes('Quick lane: one step, then a pull request.'), why);
  const shipped = await until(async () => { const v = await ship(c, id); return v.prs.length > 0 && v; }, { label: 'real ship opened', timeoutMs: 15 * 60_000, everyMs: 3000 });
  ev.check(`one pull request opened on ${REPO}`, shipped.prs.length === 1 && shipped.prs[0].repo === REPO, shipped.prs);
  const pr = prs().find((p) => p.number === shipped.prs[0].number);
  const fixed = execFileSync('git', ['--git-dir', join(SCRATCH, 'origin.git'), 'show', `${pr.headRefName}:README.md`], { encoding: 'utf8' });
  ev.check('the pushed branch has Claude Code\'s fix on origin', fixed.includes('Acceptance project') && !fixed.includes('Acceptence'), fixed.slice(0, 120));
  const runs = c.sql("SELECT r.status, p.adapter_id AS adapter FROM runs r JOIN runtime_profiles p ON p.id = r.runtime_profile_id JOIN mission_tasks t ON t.id = r.task_id WHERE t.mission_id = ?", id);
  ev.check('the step ran on Claude Code', runs.some((r) => r.adapter === 'claude-code' && r.status === 'SUCCEEDED'), runs);
  const created = ghCalls().filter((x) => x.args[0] === 'pr' && x.args[1] === 'create');
  ev.check('the fake gh saw `pr create` (never real GitHub)', created.length >= 1, created.map((x) => x.args.join(' ')).slice(-1));
  const card = await shipCardText(c, id, (t) => t.includes('Open in GitHub'));
  ev.check('the ship card shows the pull request', card.includes(`${REPO} #${shipped.prs[0].number}`), card);
  await shot(c, ev, 'real-ship-card');
  void readFileSync;
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
} finally {
  await api.patch(`/v1/workspaces/${env.workspaceId}`, { routing });
}
c.close(); ev.save();
