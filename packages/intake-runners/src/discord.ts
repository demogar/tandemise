import type { Closure, ClosureResult, IntakeRunner, RunnerContext, RunnerHandle, RunnerSignal } from '@tandemise/domain';
import { TandemiseError, errorMessage } from '@tandemise/shared';
import { mentionTriggers, replyAddress, replyPrefix, replyText, splitInstance, titleOf, triggerEmoji } from './chat.js';
import { MAX_DESCRIPTION, SourceHttp, closureFailure, cut, isoTime, record, secretMissing, text, tokenRefused } from './http.js';
import { SerialQueue, SocketLoop } from './socket.js';

const LABEL = 'Discord';
/** Plan Task 12: Discord's v10 REST API unless the source names its own (a fake). */
const DEFAULT_API = 'https://discord.com/api/v10';
/** Plan Task 12: GUILD_MESSAGES (1<<9), GUILD_MESSAGE_REACTIONS (1<<10), MESSAGE_CONTENT (1<<15): 34304. */
export const DISCORD_INTENTS = (1 << 9) | (1 << 10) | (1 << 15);
/** The acknowledgement reaction (spec: on by default, not a message). */
const ACK_EMOJI = '👀';
/** Messages after the original read per page, and at most this many pages, when looking for the bot's own reply. */
const PAGE = 50;
const MAX_PAGES = 10;
/** The gateway's close code for a token it refused. */
const AUTH_FAILED = 4004;

async function client(ctx: RunnerContext): Promise<{ http: SourceHttp; token: string }> {
  const token = await ctx.secrets.get('botToken');
  if (token === undefined || token === '') throw new TandemiseError('PRECONDITION_FAILED', secretMissing(LABEL, 'bot token'));
  return { http: new SourceHttp({ label: LABEL, base: ctx.source.api ?? DEFAULT_API, token, scheme: 'Bot', signal: ctx.signal }), token };
}

function placeOf(ctx: RunnerContext): { guild: string; channel: string } {
  const parts = splitInstance(ctx.source.instance);
  if (parts === null) throw new TandemiseError('PRECONDITION_FAILED', `Name this Discord source's instance as <server id>#<channel id>, not '${ctx.source.instance}'.`);
  return { guild: parts.scope, channel: parts.channel };
}

/** Discord's ids are snowflakes: the later message has the larger number. */
function later(a: string, b: string): string {
  try {
    return BigInt(a) >= BigInt(b) ? a : b;
  } catch {
    return a;
  }
}

/**
 * Discord as an intake runner (spec §2, §8; plan Task 12). The source's
 * instance is `<guild id>#<channel id>`; the secret is `botToken`.
 *
 * It listens on the gateway and never reads the channel wholesale: only a
 * `MESSAGE_REACTION_ADD` with the source's emoji (`:tandemise:` by default),
 * or a `MESSAGE_CREATE` that mentions the bot unless mentions are off, in the
 * source's channel, files anything. The signal is that message, which gets
 * 👀 as the acknowledgement. Discord sends every event to every connection,
 * so several daemons rely on the source claim or on dedupe (spec §3).
 */
export class DiscordRunner implements IntakeRunner {
  readonly kind = 'discord';
  readonly mode = 'socket' as const;

  start(ctx: RunnerContext): RunnerHandle {
    const listener = new DiscordListener(ctx);
    return { stop: () => listener.stop() };
  }

  /**
   * Spec §8: one reply to the original message, "Done: <title> · <key> · <PR>".
   * Exactly once across restarts (Review Focus 5): the messages after the
   * original are read first, and the bot's own reply that references it and
   * already starts "Done:" is the closure, so nothing is posted again. A
   * won't-do item replies "Not planned: …" only with `closeWontDo`.
   */
  async close(closure: Closure, ctx: RunnerContext): Promise<ClosureResult> {
    if (closure.kind !== 'done' && !ctx.source.closeWontDo) return { ok: true, externalId: null };
    try {
      const target = replyAddress(closure);
      if (target === null) throw new TandemiseError('PRECONDITION_FAILED', `This Discord signal has no message to reply to (${closure.signal.key}).`);
      const { http } = await client(ctx);
      const me = text(record(await http.getJson('/users/@me'))['id']);
      const prefix = replyPrefix(closure.kind);
      let after = target.id;
      for (let page = 0; page < MAX_PAGES; page++) {
        const list = await http.getJson(`/channels/${enc(target.channel)}/messages`, { after, limit: String(PAGE) });
        const messages = (Array.isArray(list) ? list : []).map(record);
        const mine = messages.find((m) =>
          me !== undefined && text(record(m['author'])['id']) === me
          && text(record(m['message_reference'])['message_id']) === target.id
          && (text(m['content']) ?? '').startsWith(prefix));
        if (mine !== undefined) return { ok: true, externalId: text(mine['id']) ?? null };
        if (messages.length < PAGE) break;
        for (const m of messages) after = later(text(m['id']) ?? after, after);
      }
      const posted = await http.sendJson('POST', `/channels/${enc(target.channel)}/messages`, {
        content: replyText(closure),
        message_reference: { message_id: target.id },
        allowed_mentions: { parse: [] },
      });
      return { ok: true, externalId: text(record(posted)['id']) ?? null };
    } catch (e) {
      return closureFailure(e);
    }
  }
}

/** One started Discord source: the gateway session, its heartbeat, and the events it files, one at a time. */
class DiscordListener {
  readonly #ctx: RunnerContext;
  readonly #loop: SocketLoop;
  readonly #queue: SerialQueue;
  #sequence: number | null = null;
  #botId: string | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #acked = true;

  constructor(ctx: RunnerContext) {
    this.#ctx = ctx;
    this.#queue = new SerialQueue((e) => { ctx.log.warn('intake.discord_event_failed', { error: errorMessage(e) }); });
    this.#loop = new SocketLoop({
      label: LABEL,
      ctx,
      connect: async () => {
        const { http, token } = await client(ctx);
        const url = text(record(await http.getJson('/gateway/bot'))['url']);
        if (url === undefined) throw new TandemiseError('INTEGRATION_FAILED', 'Discord named no gateway to connect to.', { retryable: true });
        this.#sequence = null;
        return {
          url: `${url}?v=10&encoding=json`,
          session: {
            onMessage: (socket, data) => { this.#frame(socket, data, token); },
            onClose: (code) => {
              this.#stopHeartbeat();
              if (code === AUTH_FAILED) ctx.log.warn('intake.discord_token_refused', { error: tokenRefused(LABEL) });
            },
          },
        };
      },
    });
  }

  async stop(): Promise<void> {
    await this.#loop.stop();
    this.#stopHeartbeat();
    await this.#queue.idle();
  }

  #frame(socket: WebSocket, data: string, token: string): void {
    const frame = record(JSON.parse(data) as unknown);
    if (typeof frame['s'] === 'number') this.#sequence = frame['s'];
    switch (frame['op']) {
      case 10: { // Hello: beat at the interval Discord asks for, then identify.
        const interval = record(frame['d'])['heartbeat_interval'];
        this.#startHeartbeat(socket, typeof interval === 'number' && interval > 0 ? interval : 41_250);
        socket.send(JSON.stringify({
          op: 2,
          d: { token, intents: DISCORD_INTENTS, properties: { os: process.platform, browser: 'tandemise', device: 'tandemise' } },
        }));
        return;
      }
      case 11: // Heartbeat ACK
        this.#acked = true;
        return;
      case 1: // Discord asks for a beat now.
        this.#beat(socket);
        return;
      case 7: // Reconnect
      case 9: // Invalid session: identify afresh on a new socket.
        socket.close(4000);
        return;
      case 0:
        this.#dispatch(text(frame['t']), record(frame['d']));
        return;
      default:
    }
  }

  #startHeartbeat(socket: WebSocket, intervalMs: number): void {
    this.#stopHeartbeat();
    this.#acked = true;
    this.#heartbeat = setInterval(() => {
      // No ACK since the last beat: the connection is a zombie; a new one is opened.
      if (!this.#acked) { socket.close(4000); return; }
      this.#acked = false;
      this.#beat(socket);
    }, intervalMs);
    this.#heartbeat.unref();
  }

  #beat(socket: WebSocket): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: 1, d: this.#sequence }));
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  /** Files the message an event names; every other event is ignored (spec §2). */
  #dispatch(type: string | undefined, d: Readonly<Record<string, unknown>>): void {
    const source = this.#ctx.source;
    if (type === 'READY') {
      this.#botId = text(record(d['user'])['id']) ?? null;
      return;
    }
    if (!this.#inSource(d)) return;
    if (type === 'MESSAGE_REACTION_ADD') {
      const channel = text(d['channel_id']);
      const message = text(d['message_id']);
      if (text(record(d['emoji'])['name']) !== triggerEmoji(source) || channel === undefined || message === undefined) return;
      if (this.#botId !== null && text(d['user_id']) === this.#botId) return;
      const reporter = text(record(record(d['member'])['user'])['username']) ?? text(d['user_id']);
      this.#queue.push(() => this.#file(channel, message, reporter));
      return;
    }
    if (type === 'MESSAGE_CREATE' && mentionTriggers(source) && this.#botId !== null) {
      const channel = text(d['channel_id']);
      const message = text(d['id']);
      const author = record(d['author']);
      if (channel === undefined || message === undefined || text(author['id']) === this.#botId) return;
      const mentioned = (Array.isArray(d['mentions']) ? d['mentions'] : []).some((u) => text(record(u)['id']) === this.#botId);
      if (mentioned) this.#queue.push(() => this.#file(channel, message, text(author['username'])));
    }
  }

  /** The source's server and channel only. */
  #inSource(d: Readonly<Record<string, unknown>>): boolean {
    const { guild, channel } = placeOf(this.#ctx);
    const g = text(d['guild_id']);
    return text(d['channel_id']) === channel && (g === undefined || g === guild);
  }

  async #file(channel: string, messageId: string, reporter: string | undefined): Promise<void> {
    const ctx = this.#ctx;
    if (ctx.signal.aborted) return;
    const { http } = await client(ctx);
    const message = record(await http.getJson(`/channels/${enc(channel)}/messages/${enc(messageId)}`));
    const signal = messageSignal(ctx.source.instance, placeOf(ctx).guild, channel, message, reporter);
    if (signal === null) return;
    const result = await ctx.push(signal);
    if (result.status === 'rejected') return;
    try {
      await http.sendJson('PUT', `/channels/${enc(channel)}/messages/${enc(messageId)}/reactions/${enc(ACK_EMOJI)}/@me`, undefined);
    } catch (e) {
      ctx.log.warn('intake.discord_reaction_failed', { error: errorMessage(e) });
    }
  }
}

/**
 * A Discord message as a `tandemise.intake/v1` signal (plan Task 12): key
 * `<channel>:<message>`, its link, its first line as the title and the
 * message as `**<author>:** <content>`; null when Discord gave no id.
 */
export function messageSignal(
  instance: string, guild: string, channel: string, message: Readonly<Record<string, unknown>>, reporter: string | undefined,
): RunnerSignal | null {
  const id = text(message['id']);
  if (id === undefined) return null;
  const author = text(record(message['author'])['username']) ?? 'someone';
  const content = text(message['content']) ?? '';
  const occurredAt = isoTime(message['timestamp']);
  return {
    schema: 'tandemise.intake/v1',
    source: { kind: 'discord', instance },
    key: `${channel}:${id}`,
    url: `https://discord.com/channels/${guild}/${channel}/${id}`,
    title: titleOf(content, `A Discord message from ${author}`),
    description: cut(`**${author}:** ${content}`, MAX_DESCRIPTION),
    ...(reporter === undefined ? {} : { reporter: { handle: reporter } }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    reply: { address: `${channel}:${id}` },
  };
}

const enc = encodeURIComponent;
