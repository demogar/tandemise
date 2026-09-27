#!/usr/bin/env node
// A stand-in for the `gh` CLI, first on the daemon's PATH during the P3 run (see README.md).
//
// It knows exactly one pull request: the one described in $FAKE_GH_STATE (a JSON file D3 writes:
// url, number, title, body, headRefName, headRefOid, diff). For that URL it answers
// `gh pr view <url> --json <fields>` with those fields and `gh pr diff <url>` with the diff. Every
// other call gets what real gh prints for a pull request it cannot find, on stderr, with exit 1, so
// the daemon treats any other link as one nothing here can read. Each call is appended to
// $FAKE_GH_STATE.calls as one JSON line, so a scenario can show what was asked.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
if (statePath) appendFileSync(`${statePath}.calls`, `${JSON.stringify({ at: new Date().toISOString(), args })}\n`);
const pr = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;

const notFound = () => {
  const number = /\/pull\/(\d+)/.exec(args.find((a) => /^https?:\/\//.test(a)) ?? '')?.[1] ?? '0';
  process.stderr.write(`GraphQL: Could not resolve to a PullRequest with the number of ${number}. (repository.pullRequest)\n`);
  process.exit(1);
};

if (pr === null || args[0] !== 'pr' || args[2] !== pr.url) notFound();
if (args[1] === 'view') {
  const at = args.indexOf('--json');
  const fields = at < 0 ? ['number', 'title', 'body', 'headRefName', 'headRefOid', 'url'] : args[at + 1].split(',');
  process.stdout.write(`${JSON.stringify(Object.fromEntries(fields.map((f) => [f, pr[f] ?? null])))}\n`);
  process.exit(0);
}
if (args[1] === 'diff') {
  process.stdout.write(pr.diff);
  process.exit(0);
}
notFound();
