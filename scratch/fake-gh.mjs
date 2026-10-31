#!/usr/bin/env node
// A stand-in for the GitHub CLI, for P14's offline check and acceptance run.
//
// Installed as an executable `gh` first on the daemon's PATH (installFakeGh),
// it serves issues and comments from <dir>/state.json and appends every call
// to <dir>/calls.jsonl, so a check can say exactly what Tandemise asked GitHub
// to do. It knows only the commands Tandemise's issue sync uses:
//
//   gh auth status
//   gh issue list --repo o/r --label L --state open --limit N --json …
//   gh issue view N --repo o/r --json …
//   gh issue close N --repo o/r
//   gh api user
//   gh api [--hostname h] repos/o/r/issues/N/comments?per_page=100
//   gh api [--hostname h] -X POST repos/o/r/issues/N/comments -f body=…
//   gh api [--hostname h] -X PATCH repos/o/r/issues/comments/ID -f body=…
//
// And the pull requests the ship step (#53) opens, checks and merges:
//
//   gh pr list --repo o/r --head B --state all --json …
//   gh pr create --repo o/r --head B --base main --title T --body-file -   (body on stdin)
//   gh pr view N --repo o/r --json …
//   gh pr edit N --repo o/r --add-reviewer R…
//   gh pr merge N --repo o/r --squash|--merge|--rebase --match-head-commit SHA [--auto] --subject S --body B
//   gh pr update-branch N --repo o/r
//   gh repo view o/r --json autoMergeAllowed
//   gh api repos/o/r/commits/SHA/check-runs
//   gh api repos/o/r/branches/B/protection
//   gh api repos/o/r/commits?sha=B&since=…
//
// The state directory is passed by the wrapper script (--fake-state <dir>)
// because the daemon hands child processes an allow-listed environment only.
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);

/** Writes `<dir>/bin/gh` (a wrapper around this script) and an empty state; returns the bin folder for PATH. */
export function installFakeGh(dir, initial = {}) {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const wrapper = join(dir, 'bin', 'gh');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${SCRIPT}" --fake-state "${dir}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  if (!existsSync(join(dir, 'state.json'))) writeState(dir, { login: 'tandemise-owner', nextCommentId: 9001, repos: {}, ...initial });
  if (!existsSync(join(dir, 'calls.jsonl'))) writeFileSync(join(dir, 'calls.jsonl'), '');
  return join(dir, 'bin');
}

export function readState(dir) {
  return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
}

export function writeState(dir, state) {
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

/** Adds or replaces an issue; `labels` are names. */
export function putIssue(dir, repo, issue) {
  const state = readState(dir);
  const r = (state.repos[repo] ??= { issues: [], comments: {} });
  const full = {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    url: issue.url ?? `https://github.com/${repo}/issues/${issue.number}`,
    updatedAt: issue.updatedAt ?? new Date().toISOString(),
    labels: (issue.labels ?? ['tandemise']).map((name) => ({ name })),
    author: { login: issue.author ?? 'sam' },
    state: issue.state ?? 'OPEN',
  };
  r.issues = [...r.issues.filter((i) => i.number !== issue.number), full];
  writeState(dir, state);
  return full;
}

export function patchIssue(dir, repo, number, patch) {
  const state = readState(dir);
  const issue = state.repos[repo]?.issues.find((i) => i.number === number);
  if (!issue) throw new Error(`no issue ${repo}#${number}`);
  Object.assign(issue, patch, { updatedAt: patch.updatedAt ?? new Date(Date.parse(issue.updatedAt) + 60_000).toISOString() });
  writeState(dir, state);
  return issue;
}

export function commentsOf(dir, repo, number) {
  return readState(dir).repos[repo]?.comments[String(number)] ?? [];
}

/** Adds a comment as someone (a contributor, or the signed-in user when `login` is omitted). */
export function addComment(dir, repo, number, body, login) {
  const state = readState(dir);
  const r = (state.repos[repo] ??= { issues: [], comments: {} });
  const list = (r.comments[String(number)] ??= []);
  const comment = { id: state.nextCommentId++, body, user: { login: login ?? state.login } };
  list.push(comment);
  writeState(dir, state);
  return comment;
}

/** Adds or replaces a pull request (helpers for a check to move its state). */
export function putPullRequest(dir, repo, pr) {
  const state = readState(dir);
  const r = (state.repos[repo] ??= { issues: [], comments: {} });
  r.prs = [...(r.prs ?? []).filter((p) => p.number !== pr.number), pr];
  writeState(dir, state);
  return pr;
}

export function pullRequests(dir, repo) {
  return readState(dir).repos[repo]?.prs ?? [];
}

/** The check runs GitHub reports on a commit: `[{ name, status, conclusion, logTail }]`. */
export function setChecks(dir, repo, sha, checks) {
  const state = readState(dir);
  const r = (state.repos[repo] ??= { issues: [], comments: {} });
  (r.checks ??= {})[sha] = checks;
  writeState(dir, state);
}

export function setRepo(dir, repo, patch) {
  const state = readState(dir);
  const r = (state.repos[repo] ??= { issues: [], comments: {} });
  Object.assign(r, patch);
  writeState(dir, state);
}

export function calls(dir) {
  return readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ------------------------------------------------------------------ the CLI

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function pick(object, fields) {
  if (fields === undefined) return object;
  return Object.fromEntries(fields.split(',').map((f) => [f, object[f]]));
}

function main(argv) {
  const dir = flag(argv, '--fake-state');
  if (dir === undefined) fail('fake gh: no --fake-state');
  const args = argv.slice(argv.indexOf('--fake-state') + 2);
  appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ args, at: new Date().toISOString() })}\n`);
  const state = readState(dir);
  if (state.failNext) {
    // One scripted failure, e.g. an expired login, for the error path.
    const message = state.failNext;
    delete state.failNext;
    writeState(dir, state);
    fail(message);
  }
  const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const repoOf = (name) => state.repos[name] ?? { issues: [], comments: {} };

  const [group, verb] = args;
  if (group === 'pr') { prCommand(dir, state, args, out); return; }
  if (group === 'repo' && verb === 'view') {
    const r = repoOf(args[2]);
    out({ autoMergeAllowed: r.autoMergeAllowed === true });
    return;
  }
  if (group === 'auth' && verb === 'status') { process.stderr.write(`Logged in to github.com account ${state.login}\n`); return; }
  if (group === 'issue') {
    const repo = flag(args, '--repo');
    if (repo === undefined) fail('fake gh: --repo is required');
    const r = repoOf(repo);
    if (verb === 'list') {
      const label = flag(args, '--label');
      const wanted = (flag(args, '--state') ?? 'open').toUpperCase();
      const limit = Number(flag(args, '--limit') ?? 30);
      const rows = r.issues
        .filter((i) => i.state === wanted && (label === undefined || i.labels.some((l) => l.name === label)))
        .sort((a, b) => b.number - a.number)
        .slice(0, limit)
        .map((i) => pick(i, flag(args, '--json')));
      out(rows);
      return;
    }
    const number = Number(args[2]);
    const issue = r.issues.find((i) => i.number === number);
    if (issue === undefined) fail(`GraphQL: Could not resolve to an issue or pull request with the number of ${number}. (repository.issue)`);
    if (verb === 'view') { out(pick(issue, flag(args, '--json'))); return; }
    if (verb === 'close') {
      issue.state = 'CLOSED';
      writeState(dir, state);
      process.stderr.write(`✓ Closed issue ${repo}#${number}\n`);
      return;
    }
    fail(`fake gh: unknown issue command ${verb}`);
  }
  if (group === 'api') {
    const rest = args.slice(1);
    const method = (flag(rest, '-X') ?? flag(rest, '--method') ?? 'GET').toUpperCase();
    const endpoint = rest.find((a, i) => !a.startsWith('-') && !['-X', '--method', '-f', '--hostname', '-H'].includes(rest[i - 1]));
    const body = rest.find((a, i) => rest[i - 1] === '-f' && a.startsWith('body='))?.slice('body='.length);
    if (endpoint === 'user') { out({ login: state.login }); return; }
    const path = (endpoint ?? '').split('?')[0];
    let c = /^repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]+)\/check-runs$/.exec(path);
    if (c) {
      // A repository's `defaultChecks` stand for every commit that has none of its own.
      const runs = (repoOf(c[1]).checks ?? {})[c[2]] ?? repoOf(c[1]).defaultChecks ?? [];
      out({ check_runs: runs.map((k) => ({ name: k.name, status: k.status ?? 'completed', conclusion: k.conclusion ?? null, details_url: k.link ?? null, output: { summary: null, text: k.logTail ?? null } })) });
      return;
    }
    c = /^repos\/([^/]+\/[^/]+)\/branches\/([^/]+)\/protection$/.exec(path);
    if (c) {
      const p = repoOf(c[1]).protection;
      if (p === undefined) fail('gh: Branch not protected (HTTP 404)');
      out(p);
      return;
    }
    c = /^repos\/([^/]+\/[^/]+)\/commits$/.exec(path);
    if (c) {
      out((repoOf(c[1]).mainCommits ?? []).map((k) => ({ sha: k.sha, commit: { message: k.subject } })));
      return;
    }
    let m = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(path);
    if (m) {
      const r = (state.repos[m[1]] ??= { issues: [], comments: {} });
      const list = (r.comments[m[2]] ??= []);
      if (method === 'GET') { out(list); return; }
      if (method === 'POST') {
        if (body === undefined) fail('fake gh: POST needs -f body=');
        const comment = { id: state.nextCommentId++, body, user: { login: state.login } };
        list.push(comment);
        writeState(dir, state);
        out(comment);
        return;
      }
    }
    m = /^repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/.exec(path);
    if (m && method === 'PATCH') {
      const r = repoOf(m[1]);
      const comment = Object.values(r.comments).flat().find((c) => c.id === Number(m[2]));
      if (comment === undefined) fail('gh: Not Found (HTTP 404)');
      if (comment.user.login !== state.login) fail('gh: Resource not accessible by integration (HTTP 403)');
      comment.body = body;
      writeState(dir, state);
      out(comment);
      return;
    }
    fail(`fake gh: unknown api call ${method} ${endpoint}`);
  }
  fail(`fake gh: unknown command ${args.join(' ')}`);
}

function prCommand(dir, state, args, out) {
  const verb = args[1];
  const repo = flag(args, '--repo');
  if (repo === undefined) fail('fake gh: --repo is required');
  const r = (state.repos[repo] ??= { issues: [], comments: {} });
  const prs = (r.prs ??= []);
  const save = () => writeState(dir, state);
  if (verb === 'list') {
    const head = flag(args, '--head');
    out(prs.filter((p) => head === undefined || p.headRefName === head).map((p) => pick(p, flag(args, '--json'))));
    return;
  }
  if (verb === 'create') {
    const head = flag(args, '--head');
    const bodyFile = flag(args, '--body-file');
    const body = bodyFile === '-' ? readFileSync(0, 'utf8') : bodyFile !== undefined ? readFileSync(bodyFile, 'utf8') : (flag(args, '--body') ?? '');
    let sha = '0'.repeat(40);
    try { sha = execFileSync('git', ['rev-parse', `refs/heads/${head}`], { encoding: 'utf8' }).trim(); } catch { /* not a local branch */ }
    const number = (state.nextPrNumber ?? 1);
    state.nextPrNumber = number + 1;
    const pr = {
      number, url: `https://github.com/${repo}/pull/${number}`, title: flag(args, '--title') ?? '', body,
      headRefName: head, headRefOid: sha, baseRefName: flag(args, '--base') ?? 'main', state: 'OPEN',
      isDraft: args.includes('--draft'), mergedBy: null, mergeCommit: null, reviewers: [], reviews: [],
    };
    prs.push(pr);
    save();
    process.stdout.write(`${pr.url}\n`);
    return;
  }
  const number = Number(args[2]);
  const pr = prs.find((p) => p.number === number);
  if (pr === undefined) fail(`GraphQL: Could not resolve to a PullRequest with the number of ${number}.`);
  if (verb === 'view') { out(pick(pr, flag(args, '--json'))); return; }
  if (verb === 'edit') {
    args.forEach((a, i) => { if (a === '--add-reviewer') pr.reviewers.push(args[i + 1]); });
    save();
    return;
  }
  if (verb === 'update-branch') {
    pr.headRefOid = `${pr.headRefOid.slice(0, 39)}u`.replace(/[^0-9a-fu]/g, '0').replace('u', 'e');
    save();
    return;
  }
  if (verb === 'merge') {
    const match = flag(args, '--match-head-commit');
    if (match !== pr.headRefOid) fail(`GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)`);
    if (pr.state !== 'OPEN') fail(`GraphQL: Pull request is not open (mergePullRequest)`);
    if (args.includes('--auto')) { pr.autoMerge = { method: ['--squash', '--merge', '--rebase'].find((m) => args.includes(m)) }; }
    pr.state = 'MERGED';
    pr.mergedBy = { login: state.login };
    pr.mergeCommit = { oid: `${'f'.repeat(32)}${String(number).padStart(8, '0')}` };
    pr.mergeSubject = flag(args, '--subject');
    pr.mergeBody = flag(args, '--body');
    save();
    return;
  }
  fail(`fake gh: unknown pr command ${verb}`);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) main(process.argv.slice(2));
