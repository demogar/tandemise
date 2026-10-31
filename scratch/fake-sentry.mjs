#!/usr/bin/env node
// A stand-in for Sentry's REST API, for intake's offline checks and acceptance
// run (plan 2026-10-30-intake Task 11). Never a real Sentry.
//
// In process: `startFakeSentry(options)` serves on 127.0.0.1 on a free port
// and hands back its state, so a check can say exactly what the Sentry runner
// asked Sentry to do. As a script, for the acceptance run:
//
//   node scratch/fake-sentry.mjs --port 0 --state <dir> [--token sntrys_test] [--org acme] [--project web] [--repos acme/web,acme/api]
//
// it writes its base URL to <dir>/url and persists everything to
// <dir>/state.json after each change (and reads it back on start). The
// acceptance run seeds and inspects it over HTTP too:
//
//   POST /_fake/issues      { id?, title, count, userCount, … }  puts an issue (unresolved)
//   GET  /_fake/state                                            issues, repos and calls
//
// It knows only the endpoints the Sentry runner uses (bearer token required):
//
//   GET /api/0/projects/<org>/<project>/issues/?query=is:unresolved&statsPeriod=24h
//   GET /api/0/organizations/<org>/repos/
//   PUT /api/0/issues/<id>/                 { status, statusDetails }
//
// Lists answer in pages of `pageSize` (unlimited unless set) with Sentry's
// `Link` header (`rel="next"; results="true"; cursor="0:<offset>:0"`), and
// `releases: false` makes `statusDetails.inNextRelease` answer 400, as a
// Sentry project without releases does (Ruling 25).
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Sentry's own signature for a webhook body: HMAC-SHA256 hex with the integration's client secret. */
export function sentrySignature(body, clientSecret) {
  return createHmac('sha256', clientSecret).update(body).digest('hex');
}

export async function startFakeSentry(options = {}) {
  const token = options.token ?? 'sntrys_test';
  const org = options.org ?? 'acme';
  const project = options.project ?? 'web';
  const persist = options.stateDir ? join(options.stateDir, 'state.json') : null;

  /** id → issue, as Sentry answers it */
  const issues = new Map();
  /** repositories linked in the organization: [{ id, name }] */
  let repos = (options.repos ?? ['acme/web']).map((name, i) => ({ id: String(i + 1), name, provider: { id: 'integrations:github', name: 'GitHub' } }));
  /** every request: { method, path, query (URLSearchParams), authorization, body } */
  const calls = [];
  let nextId = 4501234567;
  /** When set, every `PUT /api/0/issues/<id>/` answers this status (intake plan Task 13: a closure that keeps failing). */
  let putStatus = null;
  /** Ruling 25: a project with no releases refuses "resolve in the next release" with 400. */
  let releases = options.releases ?? true;
  /** Ruling 25: items per page of a list; Infinity answers one page. */
  let pageSize = options.pageSize ?? Infinity;

  if (persist && existsSync(persist)) {
    const saved = JSON.parse(readFileSync(persist, 'utf8'));
    for (const i of saved.issues ?? []) issues.set(i.id, i);
    repos = saved.repos ?? repos;
    calls.push(...(saved.calls ?? []).map((c) => ({ ...c, query: new URLSearchParams(c.query ?? '') })));
    nextId = saved.nextId ?? nextId;
  }
  const save = () => {
    if (!persist) return;
    writeFileSync(persist, JSON.stringify({
      issues: [...issues.values()], repos, nextId,
      calls: calls.map((c) => ({ ...c, query: c.query.toString() })),
    }, null, 2));
  };

  /** Puts (or replaces) an issue; `count` is a string, as Sentry sends it. */
  const putIssue = (i) => {
    const id = String(i.id ?? nextId++);
    if (Number(id) >= nextId) nextId = Number(id) + 1;
    const at = new Date().toISOString();
    const issue = {
      id, shortId: `WEB-${id.slice(-3)}`, title: 'An error', culprit: '', level: 'error', status: 'unresolved', statusDetails: {},
      count: '1', userCount: 0, firstSeen: at, lastSeen: at, permalink: `https://${org}.sentry.io/issues/${id}/`,
      metadata: {}, project: { slug: project },
      ...i,
      id,
    };
    if (typeof issue.count === 'number') issue.count = String(issue.count);
    issues.set(id, issue);
    save();
    return issue;
  };
  const setRepos = (names) => {
    repos = names.map((name, i) => ({ id: String(i + 1), name, provider: { id: 'integrations:github', name: 'GitHub' } }));
    save();
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const u = new URL(req.url, 'http://fake');
      const path = u.pathname;
      const send = (status, body, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      /** One page of `all` at `?cursor=0:<offset>:0`, with Sentry's Link header for the previous and next pages. */
      const sendPage = (all) => {
        const offset = Number((u.searchParams.get('cursor') ?? '0:0:0').split(':')[1] ?? 0) || 0;
        const size = Number.isFinite(pageSize) ? pageSize : all.length || 1;
        const page = all.slice(offset, offset + size);
        const more = offset + size < all.length;
        const at = (cursor) => { const v = new URL(u.toString()); v.searchParams.set('cursor', cursor); return `http://127.0.0.1:${server.address().port}${v.pathname}${v.search}`; };
        const prev = `0:${Math.max(0, offset - size)}:1`;
        const next = `0:${offset + size}:0`;
        const link = `<${at(prev)}>; rel="previous"; results="${offset > 0}"; cursor="${prev}", <${at(next)}>; rel="next"; results="${more}"; cursor="${next}"`;
        return send(200, page, { link });
      };
      let body = null;
      try { body = raw === '' ? null : JSON.parse(raw); } catch { return send(400, { detail: 'Malformed JSON' }); }

      // The acceptance run's own door: no token, never something the runner calls.
      if (path === '/_fake/issues' && req.method === 'POST') return send(200, putIssue(body ?? {}));
      if (path === '/_fake/state' && req.method === 'GET') {
        return send(200, { issues: [...issues.values()], repos, calls: calls.map((c) => ({ ...c, query: c.query.toString() })) });
      }

      calls.push({ method: req.method, path, query: u.searchParams, authorization: req.headers.authorization ?? null, body });
      save();
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { detail: 'Invalid token' });

      const list = /^\/api\/0\/projects\/([^/]+)\/([^/]+)\/issues\/$/.exec(path);
      if (list && req.method === 'GET') {
        if (list[1] !== org || list[2] !== project) return send(404, { detail: 'The requested resource does not exist' });
        const unresolvedOnly = (u.searchParams.get('query') ?? '').includes('is:unresolved');
        return sendPage([...issues.values()].filter((i) => !unresolvedOnly || i.status === 'unresolved'));
      }
      const orgRepos = /^\/api\/0\/organizations\/([^/]+)\/repos\/$/.exec(path);
      if (orgRepos && req.method === 'GET') {
        if (orgRepos[1] !== org) return send(404, { detail: 'The requested resource does not exist' });
        return sendPage(repos);
      }
      const one = /^\/api\/0\/issues\/([^/]+)\/$/.exec(path);
      if (one && req.method === 'PUT') {
        if (putStatus !== null) return send(putStatus, { detail: 'Internal Error' });
        const issue = issues.get(one[1]);
        if (!issue) return send(404, { detail: 'The requested resource does not exist' });
        if (!releases && body?.statusDetails?.inNextRelease) {
          return send(400, { statusDetails: ["No release data present in the system to form a basis for 'Next Release'"] });
        }
        if (body?.status !== undefined) issue.status = body.status;
        issue.statusDetails = body?.statusDetails ?? {};
        save();
        return send(200, issue);
      }
      return send(404, { detail: `No route ${req.method} ${path}` });
    });
  });

  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    issues,
    calls,
    putIssue,
    setRepos,
    /** Every later issue update answers `status` (e.g. 500) until `failPuts(null)`. */
    failPuts(status) { putStatus = status; },
    get repos() { return repos; },
    /** Ruling 25: whether the project has releases (`inNextRelease` answers 400 without). */
    setReleases(on) { releases = on; },
    /** Ruling 25: items per page of a list (Infinity for one page). */
    setPageSize(n) { pageSize = n; },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ------------------------------------------------------------------ script mode
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
  };
  const stateDir = arg('state');
  if (!stateDir) {
    console.error('usage: node scratch/fake-sentry.mjs --port 0 --state <dir> [--token sntrys_test] [--org acme] [--project web] [--repos acme/web]');
    process.exit(2);
  }
  mkdirSync(stateDir, { recursive: true });
  const fake = await startFakeSentry({
    port: Number(arg('port', '0')),
    stateDir,
    token: arg('token', 'sntrys_test'),
    org: arg('org', 'acme'),
    project: arg('project', 'web'),
    repos: arg('repos', 'acme/web').split(',').filter((r) => r !== ''),
  });
  writeFileSync(join(stateDir, 'url'), fake.url);
  console.log(`fake Sentry on ${fake.url} (state in ${stateDir})`);
  const stop = () => fake.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
