import type { Closure, ClosureResult, IntakeRunner, RunnerContext, RunnerHandle, RunnerSignal } from '@tandemise/domain';
import { TandemiseError, errorMessage } from '@tandemise/shared';
import { replyAddress, replyPrefix, replyText, mentionTriggers, splitInstance, titleOf, triggerEmoji } from './chat.js';
import { MAX_DESCRIPTION, SourceHttp, closureFailure, cut, record, secretMissing, text, tokenRefused } from './http.js';
import { SerialQueue, SocketLoop } from './socket.js';

const LABEL = 'Slack';
/** Plan Task 12: Slack's Web API unless the source names its own (a fake). */
const DEFAULT_API = 'https://slack.com/api';
/** Slack's answers for a token it will not take: the person saves a new one. */
const TOKEN_ERRORS = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired']);
/** Slack's answers for something that is not there (a deleted thread, a channel the app left). */
const MISSING_ERRORS = new Set(['channel_not_found', 'thread_not_found', 'message_not_found']);
/** Slack's answers worth trying again. */
const RETRY_ERRORS = new Set(['ratelimited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout']);
/** At most this many pages of a thread are read (200 messages each). */
const MAX_PAGES = 10;

type Message = Readonly<Record<string, unknown>>;

/**
 * Slack's Web API (plan Task 12). Slack answers 200 with `{ ok: false, error }`
 * for a refusal, so every answer is checked here and turned into the same
 * `TandemiseError`s `SourceHttp` raises for HTTP failures.
 */
class SlackApi {
  readonly #http: SourceHttp;

  constructor(ctx: RunnerContext, token: string) {
    this.#http = new SourceHttp({ label: LABEL, base: ctx.source.api ?? DEFAULT_API, token, signal: ctx.signal });
  }

  async read(method: string, query: Readonly<Record<string, string | undefined>>): Promise<Readonly<Record<string, unknown>>> {
    return answer(method, await this.#http.getJson(`/${method}`, query));
  }

  async write(method: string, body: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> {
    return answer(method, await this.#http.sendJson('POST', `/${method}`, body));
  }

  /** Slack's error code for a refusal, or null when it went through; any other failure throws. */
  async tryWrite(method: string, body: Readonly<Record<string, unknown>>): Promise<string | null> {
    try {
      await this.write(method, body);
      return null;
    } catch (e) {
      const code = e instanceof TandemiseError ? e.details['slackError'] : undefined;
      if (typeof code === 'string') return code;
      throw e;
    }
  }

  /** The thread a message is in, root first (`conversations.replies`, every page). */
  async thread(channel: string, ts: string): Promise<readonly Message[]> {
    const out: Message[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.read('conversations.replies', { channel, ts, limit: '200', cursor });
      for (const m of Array.isArray(res['messages']) ? res['messages'] : []) out.push(record(m));
      cursor = text(record(res['response_metadata'])['next_cursor']);
      if (cursor === undefined || res['has_more'] === false) break;
    }
    return out;
  }
}

function answer(method: string, raw: unknown): Readonly<Record<string, unknown>> {
  const res = record(raw);
  if (res['ok'] === true) return res;
  const error = text(res['error']) ?? 'unknown_error';
  const details = { method, slackError: error };
  if (TOKEN_ERRORS.has(error)) throw new TandemiseError('INTEGRATION_FAILED', tokenRefused(LABEL), { retryable: false, details });
  if (MISSING_ERRORS.has(error)) throw new TandemiseError('NOT_FOUND', `Slack has no such conversation or message (${error} on ${method}).`, { details });
  throw new TandemiseError('INTEGRATION_FAILED', `Slack answered ${error} to ${method}.`, { retryable: RETRY_ERRORS.has(error), details });
}

async function api(ctx: RunnerContext, secret: 'appToken' | 'botToken'): Promise<SlackApi> {
  const token = await ctx.secrets.get(secret);
  if (token === undefined || token === '') {
    throw new TandemiseError('PRECONDITION_FAILED', secretMissing(LABEL, secret === 'appToken' ? 'app-level token' : 'bot token'));
  }
  return new SlackApi(ctx, token);
}

function channelOf(ctx: RunnerContext): string {
  const parts = splitInstance(ctx.source.instance);
  if (parts === null) throw new TandemiseError('PRECONDITION_FAILED', `Name this Slack source's instance as <workspace>#<channel>, not '${ctx.source.instance}'.`);
  return parts.channel.replace(/^#/, '').toLowerCase();
}

/**
 * Slack as an intake runner (spec §2, §8; plan Task 12). The source's
 * instance is `<workspace>#<channel>` (the channel by name or id); the secrets
 * are `appToken` (Socket Mode) and `botToken` (everything else).
 *
 * It listens over Socket Mode and never reads the channel wholesale: only a
 * `reaction_added` with the source's emoji (`:tandemise:` by default), or an
 * `app_mention` unless mentions are off, in the source's channel, files
 * anything. The signal is that message's thread so far, keyed by the thread's
 * root, so a second reaction in the same thread is the same signal. The
 * thread's root then gets `:eyes:` (spec: the acknowledgement is on by
 * default and is not a message).
 */
export class SlackRunner implements IntakeRunner {
  readonly kind = 'slack';
  readonly mode = 'socket' as const;
  /** Where the source's secrets go when it sets no `api` (Ruling 23). */
  readonly defaultApi = DEFAULT_API;

  start(ctx: RunnerContext): RunnerHandle {
    const listener = new SlackListener(ctx);
    return { stop: () => listener.stop() };
  }

  /**
   * Spec §8: one reply in the thread, then `:eyes:` swapped for
   * `:white_check_mark:`. Exactly once across restarts (Review Focus 5): the
   * thread is read first, and a reply by this app's bot user (`auth.test`)
   * that already starts "Done:" is the closure, so nothing is posted again.
   * A won't-do item replies "Not planned: …" only with `closeWontDo`.
   */
  async close(closure: Closure, ctx: RunnerContext): Promise<ClosureResult> {
    if (closure.kind !== 'done' && !ctx.source.closeWontDo) return { ok: true, externalId: null };
    try {
      const thread = replyAddress(closure);
      if (thread === null) throw new TandemiseError('PRECONDITION_FAILED', `This Slack signal has no thread to reply in (${closure.signal.key}).`);
      const slack = await api(ctx, 'botToken');
      const me = await slack.write('auth.test', {});
      const userId = text(me['user_id']);
      const botId = text(me['bot_id']);
      const prefix = replyPrefix(closure.kind);
      const mine = (await slack.thread(thread.channel, thread.id)).find((m) =>
        ((userId !== undefined && text(m['user']) === userId) || (botId !== undefined && text(m['bot_id']) === botId))
        && (text(m['text']) ?? '').startsWith(prefix));
      let externalId = mine === undefined ? null : text(mine['ts']) ?? null;
      if (mine === undefined) {
        const posted = await slack.write('chat.postMessage', { channel: thread.channel, thread_ts: thread.id, text: replyText(closure), unfurl_links: false });
        externalId = text(posted['ts']) ?? null;
      }
      if (closure.kind === 'done') await swapReaction(slack, thread.channel, thread.id, ctx);
      return { ok: true, externalId };
    } catch (e) {
      return closureFailure(e);
    }
  }
}

/** `:eyes:` off, `:white_check_mark:` on. Already so is fine; any other refusal is logged, never fails the closure. */
async function swapReaction(slack: SlackApi, channel: string, ts: string, ctx: RunnerContext): Promise<void> {
  try {
    const removed = await slack.tryWrite('reactions.remove', { channel, timestamp: ts, name: 'eyes' });
    const added = await slack.tryWrite('reactions.add', { channel, timestamp: ts, name: 'white_check_mark' });
    for (const code of [removed, added]) {
      if (code !== null && code !== 'no_reaction' && code !== 'already_reacted') ctx.log.warn('intake.slack_reaction_failed', { error: code });
    }
  } catch (e) {
    ctx.log.warn('intake.slack_reaction_failed', { error: errorMessage(e) });
  }
}

/** One started Slack source: the socket, and the events it files, one at a time. */
class SlackListener {
  readonly #ctx: RunnerContext;
  readonly #loop: SocketLoop;
  readonly #queue: SerialQueue;
  /** Channel id → name, for a source that names its channel. */
  readonly #names = new Map<string, string>();

  constructor(ctx: RunnerContext) {
    this.#ctx = ctx;
    this.#queue = new SerialQueue((e) => { ctx.log.warn('intake.slack_event_failed', { error: errorMessage(e) }); });
    this.#loop = new SocketLoop({
      label: LABEL,
      ctx,
      connect: async () => {
        const opened = await (await api(ctx, 'appToken')).write('apps.connections.open', {});
        const url = text(opened['url']);
        if (url === undefined) throw new TandemiseError('INTEGRATION_FAILED', 'Slack opened no Socket Mode connection.', { retryable: true });
        return { url, session: { onMessage: (socket, data) => { this.#frame(socket, data); } } };
      },
    });
  }

  async stop(): Promise<void> {
    await this.#loop.stop();
    await this.#queue.idle();
  }

  #frame(socket: WebSocket, data: string): void {
    const frame = record(JSON.parse(data) as unknown);
    // Ack first: Slack sends an envelope again when it is not acked within 3 s.
    const envelopeId = text(frame['envelope_id']);
    if (envelopeId !== undefined) socket.send(JSON.stringify({ envelope_id: envelopeId }));
    if (frame['type'] === 'disconnect') { socket.close(1000); return; }
    if (frame['type'] !== 'events_api') return;
    const target = this.#triggered(record(record(frame['payload'])['event']));
    if (target !== null) this.#queue.push(() => this.#file(target));
  }

  /** The message an event asks to file, or null for every other event (spec §2). */
  #triggered(event: Readonly<Record<string, unknown>>): { channel: string; ts: string; user: string | undefined } | null {
    const source = this.#ctx.source;
    if (event['type'] === 'reaction_added' && text(event['reaction']) === triggerEmoji(source)) {
      const item = record(event['item']);
      const channel = text(item['channel']);
      const ts = text(item['ts']);
      if (item['type'] !== 'message' || channel === undefined || ts === undefined) return null;
      return { channel, ts, user: text(event['user']) };
    }
    if (event['type'] === 'app_mention' && mentionTriggers(source)) {
      const channel = text(event['channel']);
      const ts = text(event['thread_ts']) ?? text(event['ts']);
      if (channel === undefined || ts === undefined) return null;
      return { channel, ts, user: text(event['user']) };
    }
    return null;
  }

  async #file(target: { channel: string; ts: string; user: string | undefined }): Promise<void> {
    const ctx = this.#ctx;
    if (ctx.signal.aborted) return;
    const slack = await api(ctx, 'botToken');
    if (!(await this.#isSourceChannel(slack, target.channel))) return;
    let thread = await slack.thread(target.channel, target.ts);
    // A reply's ts answers that reply alone: read again from the thread's root.
    const rootTs = text(thread[0]?.['thread_ts']) ?? text(thread[0]?.['ts']);
    if (rootTs === undefined) return;
    if (rootTs !== target.ts) thread = await slack.thread(target.channel, rootTs);
    const permalink = text((await slack.read('chat.getPermalink', { channel: target.channel, message_ts: rootTs }))['permalink']);
    if (permalink === undefined) throw new TandemiseError('INTEGRATION_FAILED', 'Slack gave no link to the thread.', { retryable: true });
    const signal = threadSignal(ctx.source.instance, target.channel, rootTs, permalink, thread, target.user);
    const result = await ctx.push(signal);
    if (result.status === 'rejected') return;
    const code = await slack.tryWrite('reactions.add', { channel: target.channel, timestamp: rootTs, name: 'eyes' });
    if (code !== null && code !== 'already_reacted') ctx.log.warn('intake.slack_reaction_failed', { error: code });
  }

  /** The source's channel, named by id or by name; a name is looked up once per channel. */
  async #isSourceChannel(slack: SlackApi, channelId: string): Promise<boolean> {
    const wanted = channelOf(this.#ctx);
    if (channelId.toLowerCase() === wanted) return true;
    let name = this.#names.get(channelId);
    if (name === undefined) {
      name = (text(record((await slack.read('conversations.info', { channel: channelId }))['channel'])['name']) ?? '').toLowerCase();
      this.#names.set(channelId, name);
    }
    return name === wanted;
  }
}

/** Slack escapes these three in message text; the tracker gets them back as typed. */
function unescape(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * A Slack thread as a `tandemise.intake/v1` signal (plan Task 12): key
 * `<channel>:<thread_ts>`, the root's permalink, the root's first line as the
 * title, and the thread so far as `**<user>:** <text>` lines.
 */
export function threadSignal(
  instance: string, channel: string, rootTs: string, permalink: string, thread: readonly Message[], reporter: string | undefined,
): RunnerSignal {
  const lines = thread.map((m) => `**${text(m['user']) ?? text(m['username']) ?? text(m['bot_id']) ?? 'someone'}:** ${unescape(text(m['text']) ?? '')}`);
  const at = Number(rootTs) * 1000;
  return {
    schema: 'tandemise.intake/v1',
    source: { kind: 'slack', instance },
    key: `${channel}:${rootTs}`,
    url: permalink,
    title: titleOf(unescape(text(thread[0]?.['text']) ?? ''), 'A Slack thread'),
    ...(lines.length === 0 ? {} : { description: cut(lines.join('\n'), MAX_DESCRIPTION) }),
    ...(reporter === undefined ? {} : { reporter: { handle: reporter } }),
    ...(Number.isFinite(at) ? { occurredAt: new Date(at).toISOString() } : {}),
    reply: { address: `${channel}:${rootTs}` },
  };
}
