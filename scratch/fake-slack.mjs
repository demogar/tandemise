#!/usr/bin/env node
// A stand-in for Slack's Web API and Socket Mode, for intake's offline checks
// and acceptance run (plan 2026-10-30-intake Task 12). Never a real Slack.
//
// In process: `startFakeSlack(options)` serves the Web API over HTTP and
// Socket Mode over a `ws` WebSocket server, both on 127.0.0.1 on one free
// port, and hands back its state, so a check can say exactly what the Slack
// runner asked Slack to do. As a script, for the acceptance run:
//
//   node scratch/fake-slack.mjs --port 0 --state <dir> [--workspace acme] [--app-token xapp-test] [--bot-token xoxb-test]
//
// it writes its base URL (the Web API's, `<url>` + method names) to <dir>/url
// and persists everything to <dir>/state.json after each change (and reads
// it back on start). The acceptance run seeds, drives and inspects it over
// HTTP, never through a token:
//
//   POST /_fake/messages  { channel?, user?, text, thread_ts? }   posts a message, answers it (with its ts)
//   POST /_fake/emit      { event }                              sends one events_api envelope to an open socket
//   POST /_fake/drop                                             closes every open socket
//   GET  /_fake/state                                            messages, reactions, envelopes, acks and calls
//
// It knows only the Web API methods the Slack runner uses (a bearer token
// required; Slack answers 200 with `{ ok: false, error }` on a refusal):
//
//   POST apps.connections.open   (app token)  → { ok, url }  the Socket Mode URL
//   POST auth.test               (bot token)  → { ok, user_id }
//   GET  conversations.info      ?channel
//   GET  conversations.replies   ?channel&ts  (the thread, root first)
//   GET  chat.getPermalink       ?channel&message_ts
//   POST chat.postMessage        { channel, thread_ts?, text }
//   POST reactions.add           { channel, timestamp, name }
//   POST reactions.remove        { channel, timestamp, name }
//
// Over the socket it sends `hello`, then one envelope per `emit`, and
// records every `{ envelope_id }` the runner acks. `failOpen(error)` makes
// `apps.connections.open` answer `{ ok: false, error }` until `failOpen(null)`,
// and `disconnect(reason)` sends a `disconnect` envelope (Ruling 25).
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `ws` is a daemon dependency; resolve it from there so this file works from any cwd.
const require = createRequire(new URL('../apps/daemon/package.json', import.meta.url));
const { WebSocketServer } = require('ws');

export async function startFakeSlack(options = {}) {
  const workspace = options.workspace ?? 'acme';
  const appToken = options.appToken ?? 'xapp-test';
  const botToken = options.botToken ?? 'xoxb-test';
  const botUser = options.botUser ?? 'U0BOT';
  const persist = options.stateDir ? join(options.stateDir, 'state.json') : null;

  /** channel id → name */
  let channels = { C0SUPPORT: 'support', C0RANDOM: 'random', ...(options.channels ?? {}) };
  /** every message: { channel, ts, user, text, thread_ts? } */
  const messages = [];
  /** `${channel}:${ts}` → names the bot reacted with */
  const reactions = new Map();
  /** every request: { method, path, query (URLSearchParams), authorization, body } */
  const calls = [];
  /** every envelope sent, and every envelope id acked */
  const envelopes = [];
  const acks = [];
  let tsCounter = 1730000000;
  let envelopeCounter = 0;
  let opened = 0;
  /** Ruling 25: when set, `apps.connections.open` answers `{ ok: false, error: openError }`. */
  let openError = null;

  if (persist && existsSync(persist)) {
    const saved = JSON.parse(readFileSync(persist, 'utf8'));
    channels = saved.channels ?? channels;
    messages.push(...(saved.messages ?? []));
    for (const [k, v] of Object.entries(saved.reactions ?? {})) reactions.set(k, new Set(v));
    calls.push(...(saved.calls ?? []).map((c) => ({ ...c, query: new URLSearchParams(c.query ?? '') })));
    envelopes.push(...(saved.envelopes ?? []));
    acks.push(...(saved.acks ?? []));
    tsCounter = saved.tsCounter ?? tsCounter;
    envelopeCounter = saved.envelopeCounter ?? envelopeCounter;
  }
  const snapshot = () => ({
    channels, messages, reactions: Object.fromEntries([...reactions].map(([k, v]) => [k, [...v]])),
    envelopes, acks, tsCounter, envelopeCounter, opened,
    calls: calls.map((c) => ({ ...c, query: c.query.toString() })),
  });
  const save = () => { if (persist) writeFileSync(persist, JSON.stringify(snapshot(), null, 2)); };

  const nextTs = () => `${++tsCounter}.000100`;
  /** Posts a message as anyone; answers it. */
  const postMessage = (m) => {
    const message = { channel: m.channel ?? 'C0SUPPORT', ts: m.ts ?? nextTs(), user: m.user ?? 'U0SAM', text: m.text ?? '', ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}) };
    messages.push(message);
    save();
    return message;
  };
  const find = (channel, ts) => messages.find((m) => m.channel === channel && m.ts === ts);
  /** The thread a message is in, root first, as `conversations.replies` answers it. */
  const thread = (channel, ts) => {
    const m = find(channel, ts);
    if (!m) return null;
    const rootTs = m.thread_ts ?? m.ts;
    const root = find(channel, rootTs);
    if (!root) return null;
    const replies = messages.filter((x) => x.channel === channel && x.thread_ts === rootTs && x.ts !== rootTs);
    // Slack answers a reply's ts with that reply alone; a root's with the whole thread.
    if (m.thread_ts && m.thread_ts !== m.ts) return [m];
    return [{ ...root, ...(replies.length > 0 ? { thread_ts: rootTs, reply_count: replies.length } : {}) }, ...replies];
  };
  const permalink = (channel, ts) => `https://${workspace}.slack.com/archives/${channel}/p${ts.replace('.', '')}`;

  // ------------------------------------------------------------------ the Web API
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const u = new URL(req.url, 'http://fake');
      const path = u.pathname;
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      let body = null;
      try { body = raw === '' ? null : JSON.parse(raw); } catch { return send(200, { ok: false, error: 'invalid_json' }); }

      if (path === '/_fake/messages' && req.method === 'POST') return send(200, postMessage(body ?? {}));
      if (path === '/_fake/emit' && req.method === 'POST') return send(200, { delivered: emit(body?.event ?? body) });
      if (path === '/_fake/drop' && req.method === 'POST') { dropSockets(); return send(200, {}); }
      if (path === '/_fake/state' && req.method === 'GET') return send(200, snapshot());

      calls.push({ method: req.method, path, query: u.searchParams, authorization: req.headers.authorization ?? null, body });
      save();
      const method = path.replace(/^\//, '');
      const arg = (name) => body?.[name] ?? u.searchParams.get(name) ?? undefined;
      const bearer = req.headers.authorization ?? '';
      const wantToken = method === 'apps.connections.open' ? appToken : botToken;
      if (bearer !== `Bearer ${wantToken}`) return send(200, { ok: false, error: 'invalid_auth' });

      switch (method) {
        case 'apps.connections.open': {
          if (openError !== null) return send(200, { ok: false, error: openError });
          const ticket = ++envelopeCounter;
          save();
          return send(200, { ok: true, url: `ws://127.0.0.1:${server.address().port}/link/?ticket=${ticket}` });
        }
        case 'auth.test':
          return send(200, { ok: true, url: `https://${workspace}.slack.com/`, team: workspace, user: 'tandemise', team_id: 'T0ACME', user_id: botUser, bot_id: 'B0BOT' });
        case 'conversations.info': {
          const id = arg('channel');
          if (!channels[id]) return send(200, { ok: false, error: 'channel_not_found' });
          return send(200, { ok: true, channel: { id, name: channels[id] } });
        }
        case 'conversations.replies': {
          const list = thread(arg('channel'), arg('ts'));
          if (!list) return send(200, { ok: false, error: 'thread_not_found' });
          return send(200, { ok: true, messages: list, has_more: false, response_metadata: { next_cursor: '' } });
        }
        case 'chat.getPermalink': {
          const channel = arg('channel');
          const ts = arg('message_ts');
          if (!find(channel, ts)) return send(200, { ok: false, error: 'message_not_found' });
          return send(200, { ok: true, channel, permalink: permalink(channel, ts) });
        }
        case 'chat.postMessage': {
          const channel = arg('channel');
          if (!channels[channel]) return send(200, { ok: false, error: 'channel_not_found' });
          const m = postMessage({ channel, user: botUser, text: arg('text') ?? '', thread_ts: arg('thread_ts') });
          return send(200, { ok: true, channel, ts: m.ts, message: m });
        }
        case 'reactions.add':
        case 'reactions.remove': {
          const channel = arg('channel');
          const ts = arg('timestamp');
          if (!find(channel, ts)) return send(200, { ok: false, error: 'message_not_found' });
          const k = `${channel}:${ts}`;
          const set = reactions.get(k) ?? new Set();
          reactions.set(k, set);
          const name = arg('name');
          if (method === 'reactions.add') {
            if (set.has(name)) return send(200, { ok: false, error: 'already_reacted' });
            set.add(name);
          } else {
            if (!set.has(name)) return send(200, { ok: false, error: 'no_reaction' });
            set.delete(name);
          }
          save();
          return send(200, { ok: true });
        }
        default:
          return send(200, { ok: false, error: 'unknown_method' });
      }
    });
  });

  // ------------------------------------------------------------------ Socket Mode
  const wss = new WebSocketServer({ server, path: '/link/' });
  const sockets = new Set();
  wss.on('connection', (socket) => {
    opened++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (data) => {
      let frame = null;
      try { frame = JSON.parse(String(data)); } catch { return; }
      if (typeof frame?.envelope_id === 'string') { acks.push(frame.envelope_id); save(); }
    });
    socket.send(JSON.stringify({ type: 'hello', num_connections: sockets.size, debug_info: { host: 'fake-slack' }, connection_info: { app_id: 'A0APP' } }));
  });

  /** Sends one event to one open connection (Slack sends each event to one of the app's connections). Answers the envelope id, or null. */
  function emit(event) {
    const socket = [...sockets].find((s) => s.readyState === 1);
    if (!socket) return null;
    const envelope = {
      envelope_id: `env-${++envelopeCounter}`, type: 'events_api', accepts_response_payload: false, retry_attempt: 0, retry_reason: '',
      payload: { token: 'verification', team_id: 'T0ACME', api_app_id: 'A0APP', type: 'event_callback', event_id: `Ev${envelopeCounter}`, event_time: Math.floor(Date.now() / 1000), event },
    };
    envelopes.push(envelope);
    save();
    socket.send(JSON.stringify(envelope));
    return envelope.envelope_id;
  }
  /** A `disconnect` envelope to every open socket, as Slack sends before closing it (Ruling 25). */
  function disconnect(reason) {
    for (const s of sockets) if (s.readyState === 1) s.send(JSON.stringify({ type: 'disconnect', reason, debug_info: { host: 'fake-slack' } }));
  }
  /** Slack goes away for a moment: every open socket is closed. */
  function dropSockets() {
    for (const s of sockets) s.close(1001, 'going away');
  }

  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    botUser,
    calls,
    messages,
    reactions,
    envelopes,
    acks,
    postMessage,
    emit,
    dropSockets,
    permalink,
    /** Sockets opened so far, and open now. */
    get opened() { return opened; },
    /** Ruling 25: `apps.connections.open` answers `{ ok: false, error }` until `failOpen(null)`. */
    failOpen(error) { openError = error; },
    disconnect,
    get open() { return [...sockets].filter((s) => s.readyState === 1).length; },
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
    console.error(`usage: node ${fileURLToPath(import.meta.url)} --port 0 --state <dir> [--workspace acme] [--app-token xapp-test] [--bot-token xoxb-test]`);
    process.exit(2);
  }
  mkdirSync(stateDir, { recursive: true });
  const fake = await startFakeSlack({
    port: Number(arg('port', '0')),
    stateDir,
    workspace: arg('workspace', 'acme'),
    appToken: arg('app-token', 'xapp-test'),
    botToken: arg('bot-token', 'xoxb-test'),
  });
  writeFileSync(join(stateDir, 'url'), fake.url);
  console.log(`fake Slack on ${fake.url} (state in ${stateDir})`);
  const stop = () => fake.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
