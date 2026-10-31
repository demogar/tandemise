#!/usr/bin/env node
// A stand-in for Discord's REST API and gateway, for intake's offline checks
// and acceptance run (plan 2026-10-30-intake Task 12). Never a real Discord.
//
// In process: `startFakeDiscord(options)` serves the REST API over HTTP and
// the gateway over a `ws` WebSocket server, both on 127.0.0.1 on one free
// port, and hands back its state, so a check can say exactly what the Discord
// runner asked Discord to do. As a script, for the acceptance run:
//
//   node scratch/fake-discord.mjs --port 0 --state <dir> [--token bot-test] [--heartbeat-ms 41250]
//
// it writes its REST base URL to <dir>/url and persists everything to
// <dir>/state.json after each change (and reads it back on start). The
// acceptance run seeds, drives and inspects it over HTTP, never through a token:
//
//   POST /_fake/messages  { channel_id?, author?, content, mentions? }   posts a message, answers it
//   POST /_fake/emit      { t, d }                                     dispatches one gateway event to every session
//   POST /_fake/drop                                                   closes every gateway socket
//   GET  /_fake/state                                                  messages, reactions, frames and calls
//
// REST, with `Authorization: Bot <token>` (401 otherwise):
//
//   GET  /gateway/bot                                  → { url, shards: 1, … }
//   GET  /users/@me                                    → the bot user
//   GET  /channels/<c>/messages/<m>
//   GET  /channels/<c>/messages?after=<m>&limit=<n>    newest first, as Discord answers
//   POST /channels/<c>/messages                        { content, message_reference? }
//   PUT  /channels/<c>/messages/<m>/reactions/<emoji>/@me
//
// The gateway sends op 10 Hello, answers each op 1 heartbeat with op 11,
// answers op 2 Identify (right token) with a READY dispatch, and records
// every frame it receives. A wrong token closes with 4004, as Discord does.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `ws` is a daemon dependency; resolve it from there so this file works from any cwd.
const require = createRequire(new URL('../apps/daemon/package.json', import.meta.url));
const { WebSocketServer } = require('ws');

export async function startFakeDiscord(options = {}) {
  const token = options.token ?? 'bot-test';
  const heartbeatMs = options.heartbeatMs ?? 41_250;
  const guildId = options.guildId ?? '900000000000000001';
  const bot = { id: options.botId ?? '900000000000000777', username: 'tandemise', bot: true };
  const persist = options.stateDir ? join(options.stateDir, 'state.json') : null;

  /** every message: { id, channel_id, guild_id, author, content, timestamp, mentions, message_reference? } */
  const messages = [];
  /** `${channel}:${message}` → emoji the bot reacted with */
  const reactions = new Map();
  /** every REST request: { method, path, query (URLSearchParams), authorization, body } */
  const calls = [];
  /** every gateway frame received from a client: { op, d } */
  const frames = [];
  let snowflake = 1_300_000_000_000_000_000n;
  let seq = 0;
  let opened = 0;

  if (persist && existsSync(persist)) {
    const saved = JSON.parse(readFileSync(persist, 'utf8'));
    messages.push(...(saved.messages ?? []));
    for (const [k, v] of Object.entries(saved.reactions ?? {})) reactions.set(k, new Set(v));
    calls.push(...(saved.calls ?? []).map((c) => ({ ...c, query: new URLSearchParams(c.query ?? '') })));
    frames.push(...(saved.frames ?? []));
    snowflake = BigInt(saved.snowflake ?? String(snowflake));
    seq = saved.seq ?? seq;
  }
  const snapshot = () => ({
    messages, reactions: Object.fromEntries([...reactions].map(([k, v]) => [k, [...v]])),
    frames, snowflake: String(snowflake), seq, opened, bot,
    calls: calls.map((c) => ({ ...c, query: c.query.toString() })),
  });
  const save = () => { if (persist) writeFileSync(persist, JSON.stringify(snapshot(), null, 2)); };

  const nextId = () => String(++snowflake);
  /** Posts a message as anyone; answers it. */
  const postMessage = (m) => {
    const message = {
      id: m.id ?? nextId(), channel_id: m.channel_id ?? '900000000000000010', guild_id: m.guild_id ?? guildId,
      author: m.author ?? { id: '900000000000000042', username: 'sam' }, content: m.content ?? '', timestamp: m.timestamp ?? new Date().toISOString(),
      mentions: m.mentions ?? [], ...(m.message_reference ? { message_reference: m.message_reference } : {}),
    };
    messages.push(message);
    save();
    return message;
  };

  // ------------------------------------------------------------------ REST
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const u = new URL(req.url, 'http://fake');
      const path = u.pathname;
      const send = (status, body) => {
        res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      let body = null;
      try { body = raw === '' ? null : JSON.parse(raw); } catch { return send(400, { message: '400: Bad Request', code: 50109 }); }

      if (path === '/_fake/messages' && req.method === 'POST') return send(200, postMessage(body ?? {}));
      if (path === '/_fake/emit' && req.method === 'POST') return send(200, { delivered: emit(body?.t, body?.d) });
      if (path === '/_fake/drop' && req.method === 'POST') { dropSockets(); return send(200, {}); }
      if (path === '/_fake/state' && req.method === 'GET') return send(200, snapshot());

      calls.push({ method: req.method, path, query: u.searchParams, authorization: req.headers.authorization ?? null, body });
      save();
      if (req.headers.authorization !== `Bot ${token}`) return send(401, { message: '401: Unauthorized', code: 0 });

      if (path === '/gateway/bot' && req.method === 'GET') {
        return send(200, { url: `ws://127.0.0.1:${server.address().port}/gateway`, shards: 1, session_start_limit: { total: 1000, remaining: 999, reset_after: 0, max_concurrency: 1 } });
      }
      if (path === '/users/@me' && req.method === 'GET') return send(200, bot);
      const one = /^\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(path);
      if (one && req.method === 'GET') {
        const m = messages.find((x) => x.channel_id === one[1] && x.id === one[2]);
        return m ? send(200, m) : send(404, { message: 'Unknown Message', code: 10008 });
      }
      const list = /^\/channels\/([^/]+)\/messages$/.exec(path);
      if (list && req.method === 'GET') {
        const after = BigInt(u.searchParams.get('after') ?? '0');
        const limit = Number(u.searchParams.get('limit') ?? '50');
        const found = messages.filter((x) => x.channel_id === list[1] && BigInt(x.id) > after)
          .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).slice(0, limit).reverse();
        return send(200, found);
      }
      if (list && req.method === 'POST') {
        const ref = body?.message_reference;
        if (ref?.message_id && !messages.some((x) => x.channel_id === list[1] && x.id === ref.message_id)) {
          return send(400, { message: 'Invalid Form Body', code: 50035 });
        }
        return send(200, postMessage({
          channel_id: list[1], author: bot, content: body?.content ?? '',
          ...(ref?.message_id ? { message_reference: { message_id: ref.message_id, channel_id: list[1], guild_id: guildId } } : {}),
        }));
      }
      const react = /^\/channels\/([^/]+)\/messages\/([^/]+)\/reactions\/([^/]+)\/@me$/.exec(path);
      if (react && req.method === 'PUT') {
        if (!messages.some((x) => x.channel_id === react[1] && x.id === react[2])) return send(404, { message: 'Unknown Message', code: 10008 });
        const k = `${react[1]}:${react[2]}`;
        reactions.set(k, (reactions.get(k) ?? new Set()).add(decodeURIComponent(react[3])));
        save();
        return send(204);
      }
      return send(404, { message: '404: Not Found', code: 0 });
    });
  });

  // ------------------------------------------------------------------ the gateway
  const wss = new WebSocketServer({ server, path: '/gateway' });
  /** sockets that identified with the right token */
  const sessions = new Set();
  const sockets = new Set();
  wss.on('connection', (socket, req) => {
    opened++;
    sockets.add(socket);
    socket.query = new URL(req.url, 'http://fake').searchParams.toString();
    socket.on('close', () => { sockets.delete(socket); sessions.delete(socket); });
    socket.on('message', (data) => {
      let frame = null;
      try { frame = JSON.parse(String(data)); } catch { return; }
      frames.push({ op: frame.op, d: frame.d, query: socket.query });
      save();
      if (frame.op === 1) socket.send(JSON.stringify({ op: 11 }));
      if (frame.op === 2) {
        if (frame.d?.token !== token) return socket.close(4004, 'Authentication failed.');
        sessions.add(socket);
        socket.send(JSON.stringify({ op: 0, t: 'READY', s: ++seq, d: { v: 10, user: bot, session_id: `session-${opened}`, resume_gateway_url: `ws://127.0.0.1:${server.address().port}/gateway`, guilds: [{ id: guildId, unavailable: true }] } }));
      }
    });
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: heartbeatMs } }));
  });

  /** Dispatches one event to every identified session (Discord sends every event to every connection). Answers how many got it. */
  function emit(t, d) {
    let n = 0;
    for (const s of sessions) {
      if (s.readyState !== 1) continue;
      s.send(JSON.stringify({ op: 0, t, s: ++seq, d }));
      n++;
    }
    save();
    return n;
  }
  function dropSockets() {
    for (const s of sockets) s.close(1001, 'going away');
  }

  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    bot,
    guildId,
    calls,
    messages,
    reactions,
    frames,
    postMessage,
    emit,
    dropSockets,
    get opened() { return opened; },
    get sessions() { return sessions.size; },
    close() {
      for (const s of sockets) s.terminate();
      wss.close();
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
    console.error(`usage: node ${fileURLToPath(import.meta.url)} --port 0 --state <dir> [--token bot-test] [--heartbeat-ms 41250]`);
    process.exit(2);
  }
  mkdirSync(stateDir, { recursive: true });
  const fake = await startFakeDiscord({
    port: Number(arg('port', '0')),
    stateDir,
    token: arg('token', 'bot-test'),
    heartbeatMs: Number(arg('heartbeat-ms', '41250')),
  });
  writeFileSync(join(stateDir, 'url'), fake.url);
  console.log(`fake Discord on ${fake.url} (state in ${stateDir})`);
  const stop = () => fake.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
