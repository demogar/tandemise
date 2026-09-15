// Thin client for the daemon under test. Reads <scratch>/env.json from setup.mjs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadEnv(scratch) {
  return JSON.parse(readFileSync(join(scratch, 'env.json'), 'utf8'));
}

export function client(env) {
  const call = async (method, path, body) => {
    const res = await fetch(`${env.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) { const e = new Error(`${method} ${path} -> ${res.status} ${text}`); e.status = res.status; e.body = json; throw e; }
    return json;
  };
  return {
    get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), patch: (p, b) => call('PATCH', p, b),
    put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p), raw: call,
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value or the deadline passes. */
export async function until(fn, { timeoutMs = 60_000, everyMs = 500, label = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}
