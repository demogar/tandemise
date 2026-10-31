#!/usr/bin/env node
// A stand-in for PostHog's error-tracking API, for intake's offline checks
// (plan 2026-10-30-intake Task 11). Never a real PostHog.
//
// In process: `startFakePostHog(options)` serves on 127.0.0.1 on a free port
// and hands back its state. As a script, for the acceptance run:
//
//   node scratch/fake-posthog.mjs --port 0 --state <dir> [--key phx_test] [--project 4242]
//
// it writes its base URL to <dir>/url and persists everything to
// <dir>/state.json after each change (and reads it back on start). Seeding
// and inspecting over HTTP: `POST /_fake/issues` and `GET /_fake/state`.
//
// It knows only the endpoints the PostHog runner uses (bearer key required):
//
//   GET   /api/projects/<id>/error_tracking/issues/?status=active   → { results: [...] }
//   PATCH /api/projects/<id>/error_tracking/issues/<issueId>/       { status }
//
// An issue is `{ id (uuid), name, description, status, first_seen, last_seen,
// occurrences, users }`. The plan pins the runner's mapping, not PostHog's
// wire format (RULINGS ruling 17).
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function startFakePostHog(options = {}) {
  const key = options.key ?? 'phx_test';
  const projectId = String(options.project ?? '4242');
  const persist = options.stateDir ? join(options.stateDir, 'state.json') : null;

  /** id → issue */
  const issues = new Map();
  /** every request: { method, path, query (URLSearchParams), authorization, body } */
  const calls = [];

  if (persist && existsSync(persist)) {
    const saved = JSON.parse(readFileSync(persist, 'utf8'));
    for (const i of saved.issues ?? []) issues.set(i.id, i);
    calls.push(...(saved.calls ?? []).map((c) => ({ ...c, query: new URLSearchParams(c.query ?? '') })));
  }
  const save = () => {
    if (!persist) return;
    writeFileSync(persist, JSON.stringify({ issues: [...issues.values()], calls: calls.map((c) => ({ ...c, query: c.query.toString() })) }, null, 2));
  };

  const putIssue = (i) => {
    const at = new Date().toISOString();
    const issue = {
      id: randomUUID(), name: 'TypeError', description: '', status: 'active', first_seen: at, last_seen: at, occurrences: 1, users: 0,
      ...i,
    };
    issues.set(issue.id, issue);
    save();
    return issue;
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const u = new URL(req.url, 'http://fake');
      const path = u.pathname;
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      let body = null;
      try { body = raw === '' ? null : JSON.parse(raw); } catch { return send(400, { detail: 'Malformed JSON' }); }

      if (path === '/_fake/issues' && req.method === 'POST') return send(200, putIssue(body ?? {}));
      if (path === '/_fake/state' && req.method === 'GET') {
        return send(200, { issues: [...issues.values()], calls: calls.map((c) => ({ ...c, query: c.query.toString() })) });
      }

      calls.push({ method: req.method, path, query: u.searchParams, authorization: req.headers.authorization ?? null, body });
      save();
      if (req.headers.authorization !== `Bearer ${key}`) return send(401, { type: 'authentication_error', detail: 'Invalid personal API key.' });

      const list = /^\/api\/projects\/([^/]+)\/error_tracking\/issues\/$/.exec(path);
      if (list && req.method === 'GET') {
        if (list[1] !== projectId) return send(404, { detail: 'Not found.' });
        const status = u.searchParams.get('status');
        const results = [...issues.values()].filter((i) => status === null || i.status === status);
        return send(200, { count: results.length, next: null, previous: null, results });
      }
      const one = /^\/api\/projects\/([^/]+)\/error_tracking\/issues\/([^/]+)\/$/.exec(path);
      if (one && req.method === 'PATCH') {
        const issue = issues.get(one[2]);
        if (one[1] !== projectId || !issue) return send(404, { detail: 'Not found.' });
        if (body?.status !== undefined) issue.status = body.status;
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
    console.error('usage: node scratch/fake-posthog.mjs --port 0 --state <dir> [--key phx_test] [--project 4242]');
    process.exit(2);
  }
  mkdirSync(stateDir, { recursive: true });
  const fake = await startFakePostHog({ port: Number(arg('port', '0')), stateDir, key: arg('key', 'phx_test'), project: arg('project', '4242') });
  writeFileSync(join(stateDir, 'url'), fake.url);
  console.log(`fake PostHog on ${fake.url} (state in ${stateDir})`);
  const stop = () => fake.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
