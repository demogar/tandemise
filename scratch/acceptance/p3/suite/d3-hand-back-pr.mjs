// D3 — Hand back a GitHub pull request link. The build step is taken to GitHub while it runs, then handed back
// in the window with https://github.com/acme/app/pull/7, which the fake `gh` (fake-gh.mjs) knows. Its head is a
// real commit that exists only on the "GitHub" remote (a bare repository the project's github.com remote is
// rewritten to), as `refs/pull/7/head`, as for a fork or another machine's work: neither the branch nor the
// commit is in the project before the hand-back. The daemon fetches it into `tandemise/pr-7`. A human-authored
// round 2 lands; its Evidence carries github.pr, git.commit and that branch; the review downstream runs on it.
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { context, SCRATCH } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import {
  addLinkInDialog, card, clickInDialog, continueElsewhere, docsSize, ensureTeam, ghCalls, openFeed, openHandBack, refs,
  startMission, waitTask, writeGhState, writeState,
} from '../common.mjs';

const c = await context();
const { page, api, until } = c;
await docsSize(c);
const ev = new Evidence('D3', 'Hand back a GitHub pull request: a human round on that commit, read downstream');
await ensureTeam(c);

// ------------------------------------------------------------ the pull request, only on the remote
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Pat Contributor', '-c', 'user.email=pat@example.invalid', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const project = c.env.project;
const branch = 'hello-from-pr';
const fetched = 'tandemise/pr-7';
// "GitHub": a bare repository the project reaches as https://github.com/acme/app.git through an insteadOf
// rewrite, so the daemon finds the remote by its GitHub URL, as it would a real one.
const remote = join(SCRATCH, 'acme-app.git');
execFileSync('git', ['init', '-q', '--bare', remote]);
git(project, 'config', `url.${remote}.insteadOf`, 'https://github.com/acme/app.git');
git(project, 'remote', 'add', 'acme', 'https://github.com/acme/app.git');
git(project, 'push', '-q', 'acme', 'main');
// The contributor's clone, somewhere else: the commit is pushed to the remote as GitHub stores a pull request.
const tree = join(SCRATCH, 'pr7');
execFileSync('git', ['clone', '-q', remote, tree]);
git(tree, 'checkout', '-q', '-b', branch);
writeFileSync(join(tree, 'hello.html'), '<h1>Hello from the pull request</h1>\n');
git(tree, 'add', 'hello.html');
git(tree, 'commit', '-q', '-m', 'Greet the visitor from the pull request');
const sha = git(tree, 'rev-parse', 'HEAD');
const diff = `${git(tree, 'diff', `main..${branch}`)}\n`;
git(tree, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
rmSync(tree, { recursive: true, force: true });
const localBranches = git(project, 'branch', '--list', branch, fetched);
let knowsCommit = true;
try { execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: project, stdio: 'ignore' }); } catch { knowsCommit = false; }
ev.check('before the hand-back the project has neither the PR\'s branch nor its commit', localBranches === '' && !knowsCommit, { localBranches, knowsCommit });
const url = 'https://github.com/acme/app/pull/7';
writeGhState({ url, number: 7, title: 'Greet the visitor by name', body: 'Adds the hello page.', headRefName: branch, headRefOid: sha, diff });
ev.note(`the fake gh knows ${url}: head ${branch} @ ${sha.slice(0, 12)}, a real commit only on the remote, as refs/pull/7/head`);

// ------------------------------------------------------------ the mission, and the build taken to GitHub
const goal = 'Hello page, finished in a pull request SCRIPTED_SLOW_20S';
const missionId = await startMission(c, goal, 'P2 chain');
writeState({ d3: { missionId, sha, branch: fetched, url } });
await waitTask(c, missionId, 'build', (t) => t.status === 'RUNNING', 'build running', 120_000);
const { parked } = await continueElsewhere(c, missionId, 'build', 'GitHub');
ev.check('the build is parked in GitHub', parked.parkedExternal?.tool === 'GitHub' && parked.status === 'AWAITING_EXTERNAL', parked.parkedExternal);

// ------------------------------------------------------------ hand back the link, in the window
await openHandBack(c, missionId, 'build', 'Finished the page in the pull request; it greets the visitor by name.');
await addLinkInDialog(c, url);
const dialog = await c.dialogText('Hand back ');
ev.check('the dialog holds the one link and asks nothing about downstream work', dialog.includes(url) && !/Keep their work|Redo them/.test(dialog), dialog);
await page.screenshot(ev.shot('hand-back-pr-link'));
await clickInDialog(c, 'Hand back');
const back = await waitTask(c, missionId, 'build', (t) => t.parkedExternal === null && t.round === 2, 'handed back', 60_000);
ev.check('proof (API): build is round 2 and SUCCEEDED, "Handed back from GitHub."', back.status === 'SUCCEEDED' && back.round === 2 && back.statusReason === 'Handed back from GitHub.', { status: back.status, round: back.round, statusReason: back.statusReason });

const detail = await api.get(`/v1/missions/${missionId}`);
const evidence = detail.artifacts.find((a) => a.type === 'Evidence' && a.taskId === back.id);
ev.check('the Evidence carries the PR\'s refs: url, github.pr acme/app#7, git.commit <head>, git.branch tandemise/pr-7', evidence !== undefined
  && refs(evidence).includes(`url=${url}`) && refs(evidence).includes('github.pr=acme/app#7') && refs(evidence).includes(`git.commit=${sha}`) && refs(evidence).includes(`git.branch=${fetched}`), refs(evidence));
let fetchedAt = '';
try { fetchedAt = git(project, 'rev-parse', `refs/heads/${fetched}`); } catch { /* not fetched */ }
ev.check('the daemon fetched the head into tandemise/pr-7 in the project, at the PR\'s head commit', fetchedAt === sha, { fetchedAt, sha });
const body = evidence ? (await api.get(`/v1/artifacts/${evidence.id}`)).body ?? '' : '';
ev.check('the Evidence is the snapshot: the PR\'s title, body and diff', body.includes('# Greet the visitor by name') && body.includes('+<h1>Hello from the pull request</h1>'), body.slice(0, 300));
const changeSet = detail.artifacts.find((a) => a.type === 'ChangeSet' && a.taskId === back.id && a.round === 2);
ev.check('a human-authored round-2 ChangeSet: authored and recorded by you, carrying the commit', changeSet !== undefined
  && changeSet.authorId === c.me && changeSet.recordedBy === c.me && refs(changeSet).includes(`git.commit=${sha}`) && refs(changeSet).includes(`git.branch=${fetched}`),
  changeSet && { authorId: changeSet.authorId, recordedBy: changeSet.recordedBy, me: c.me, round: changeSet.round, refs: refs(changeSet) });
const calls = ghCalls().map((x) => x.args.slice(0, 3).join(' '));
ev.check('the daemon read it through gh: pr view and pr diff for that URL', calls.includes(`pr view ${url}`) && calls.includes(`pr diff ${url}`), calls);

await openFeed(c, missionId);
const text = await until(async () => { const t = await card(c, 'build'); return t.includes('Round 2') && t; }, { label: 'round 2 card', timeoutMs: 20_000 }).catch(() => card(c, 'build'));
ev.check('the build card shows Round 2, by You, with "Pull request #7 ↗"', text.includes('Round 2') && /by\s*You/.test(text) && text.includes('Pull request #7'), text);
await page.evaluate(`document.querySelector('[data-feed-card="build"]')?.scrollIntoView({ block: 'center' })`);
await page.screenshot(ev.shot('build-round-2-card'));

// ------------------------------------------------------------ downstream reads that commit
const review = await waitTask(c, missionId, 'review', (t) => ['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(t.status), 'review finished', 120_000);
ev.check('the review ran and finished', review.status === 'SUCCEEDED', { status: review.status, statusReason: review.statusReason });
const run = c.runs(review.id).at(-1);
const inputs = run ? c.sql('SELECT artifact_id AS id FROM run_inputs WHERE run_id = ?', run.id).map((r) => r.id) : [];
ev.check('the review\'s run read the handed-back ChangeSet', changeSet !== undefined && inputs.includes(changeSet.id), { inputs, changeSet: changeSet?.id });
const target = c.sql('SELECT kind, branch, base_branch AS baseBranch, working_directory AS dir FROM execution_targets WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', review.id)[0];
ev.check('the review\'s worktree was cut from the fetched pull request branch', target?.baseBranch === fetched, target);
const retired = c.sql("SELECT status, branch FROM execution_targets WHERE task_id = ? AND kind = 'worktree'", back.id);
ev.check('the build\'s own worktree is retired (RELEASED), so integration would merge the PR branch instead', retired.length > 0 && retired.every((t) => t.status === 'RELEASED'), retired);
let contains = false;
try { execFileSync('git', ['merge-base', '--is-ancestor', sha, target.branch], { cwd: project }); contains = true; } catch { /* not an ancestor, or no branch */ }
ev.check('the review\'s branch contains the handed-back commit', contains, { sha, reviewBranch: target?.branch });
const prompt = c.prompts().filter((p) => p.includes(goal) && p.includes('ReviewReport')).pop() ?? '';
ev.check('the review\'s prompt carries the pull request and its diff', prompt.includes('pull request acme/app#7') && prompt.includes('+<h1>Hello from the pull request</h1>'), prompt.slice(Math.max(0, prompt.indexOf('pull request acme/app#7') - 200), prompt.indexOf('pull request acme/app#7') + 200));
await openFeed(c, missionId);
await page.evaluate(`document.querySelector('[data-feed-card="review"]')?.scrollIntoView({ block: 'center' })`);
await page.screenshot(ev.shot('review-after-hand-back'));

c.close(); ev.save();
