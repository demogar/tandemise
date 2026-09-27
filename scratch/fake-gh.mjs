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
// The state directory is passed by the wrapper script (--fake-state <dir>)
// because the daemon hands child processes an allow-listed environment only.
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

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) main(process.argv.slice(2));
