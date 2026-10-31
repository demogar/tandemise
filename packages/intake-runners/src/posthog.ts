import type {
  Closure, ClosureResult, Impact, IntakeRunner, RunnerContext, RunnerHandle, RunnerSignal, RunnerWebhookRequest,
} from '@tandemise/domain';
import { TandemiseError } from '@tandemise/shared';
import {
  MAX_DESCRIPTION, MAX_TITLE, SourceHttp, closureFailure, count, cut, header, isoTime, parseBody, record, sameText, secretMissing, text,
} from './http.js';

const LABEL = 'PostHog';
/** Plan Task 11: PostHog's US cloud unless the source names its own (EU, self-hosted, or a fake). */
const DEFAULT_API = 'https://us.posthog.com';
/** Plan Task 11: what a webhook without the source's shared secret throws. */
export const POSTHOG_SECRET_MISMATCH = "The PostHog secret doesn't match.";
/** An error-tracking issue's id is a UUID; any other key is a signal that isn't one (spec §8). */
const ISSUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PostHog error tracking as an intake runner (spec §2, §8; plan Task 11). The
 * source's instance is the project id; the secrets are `apiKey` (a personal
 * API key, for the poll and for resolving) and `webhookSecret` (the value a
 * PostHog destination sends as `X-Tandemise-Secret`). Each poll lists the
 * project's active error-tracking issues and pushes one signal per issue;
 * the noise filter decides what is kept (spec §4.1).
 *
 * PostHog's wire format was not confirmed against its live reference here
 * (RULINGS ruling 17): the counts are read from the issue itself or from its
 * `aggregations`, whichever is there, and anything missing is left out.
 */
export class PostHogRunner implements IntakeRunner {
  readonly kind = 'posthog';
  readonly mode = 'poll' as const;
  /** Where the source's secrets go when it sets no `api` (Ruling 23). */
  readonly defaultApi = DEFAULT_API;

  start(ctx: RunnerContext): RunnerHandle {
    return {
      poll: async () => {
        const http = await client(ctx);
        const page = await http.getJson(`/api/projects/${enc(projectOf(ctx))}/error_tracking/issues/`, { status: 'active' });
        const issues = Array.isArray(page) ? page : record(page)['results'];
        for (const issue of Array.isArray(issues) ? issues : []) {
          if (ctx.signal.aborted) return;
          const signal = issueSignal(ctx.source.instance, http.base, issue);
          if (signal !== null) await ctx.push(signal);
        }
      },
      stop: async () => {},
    };
  }

  /**
   * Spec §8: mark the error-tracking issue resolved. A signal that isn't an
   * error issue (an insight, a survey, pushed from a destination) closes with
   * nothing to write, and so does a won't-do item (RULINGS ruling 17).
   */
  async close(closure: Closure, ctx: RunnerContext): Promise<ClosureResult> {
    if (closure.kind !== 'done' || !ISSUE_ID.test(closure.signal.key)) return { ok: true, externalId: null };
    try {
      const http = await client(ctx);
      await http.sendJson('PATCH', `/api/projects/${enc(projectOf(ctx))}/error_tracking/issues/${enc(closure.signal.key)}/`, { status: 'resolved' });
      return { ok: true, externalId: closure.signal.key };
    } catch (e) {
      return closureFailure(e);
    }
  }

  /**
   * A delivery from a PostHog destination (spec §2 "Webhook-only sources").
   * PostHog does not sign it, so the destination sends the source's shared
   * secret as `X-Tandemise-Secret`. The body is one issue, or `{ issue }`.
   */
  async fromWebhook(req: RunnerWebhookRequest, ctx: RunnerContext): Promise<readonly RunnerSignal[]> {
    const secret = await ctx.secrets.get('webhookSecret');
    if (secret === undefined || secret === '') throw new TandemiseError('PRECONDITION_FAILED', secretMissing(LABEL, 'webhook secret'));
    if (!sameText(header(req.headers, 'x-tandemise-secret') ?? '', secret)) throw new TandemiseError('PERMISSION_DENIED', POSTHOG_SECRET_MISMATCH);
    const body = record(parseBody(req.body, LABEL));
    const signal = issueSignal(ctx.source.instance, ctx.source.api ?? DEFAULT_API, body['issue'] ?? body);
    return signal === null ? [] : [signal];
  }
}

/** One error-tracking issue as a `tandemise.intake/v1` signal; null when it has no id or name. */
export function issueSignal(projectId: string, base: string, raw: unknown): RunnerSignal | null {
  const issue = record(raw);
  const key = text(issue['id']);
  const title = text(issue['name']);
  if (key === undefined || title === undefined) return null;
  const description = text(issue['description']);
  const impact = issueImpact(issue);
  return {
    schema: 'tandemise.intake/v1',
    source: { kind: 'posthog', instance: projectId },
    key,
    url: `${webBase(base)}/project/${enc(projectId)}/error_tracking/${enc(key)}`,
    title: cut(title, MAX_TITLE),
    ...(description === undefined ? {} : { description: cut(description, MAX_DESCRIPTION) }),
    ...(Object.keys(impact).length === 0 ? {} : { impact }),
    kindHint: 'bug',
  };
}

/** Plan Task 11: `{ level: 'error', events: occurrences, users, firstSeen: first_seen, lastSeen: last_seen }`. */
function issueImpact(issue: Readonly<Record<string, unknown>>): Impact {
  const aggregations = record(issue['aggregations']);
  const events = count(issue['occurrences'] ?? aggregations['occurrences']);
  const users = count(issue['users'] ?? aggregations['users']);
  const firstSeen = isoTime(issue['first_seen']);
  const lastSeen = isoTime(issue['last_seen']);
  return {
    level: 'error',
    ...(events === undefined ? {} : { events }),
    ...(users === undefined ? {} : { users }),
    ...(firstSeen === undefined ? {} : { firstSeen }),
    ...(lastSeen === undefined ? {} : { lastSeen }),
  };
}

/**
 * The web app is served where the API is. A signal's link must be https
 * (spec §1); an http base is only ever loopback (the source's `api` allows
 * nothing else), so its link is written as https (RULINGS ruling 17).
 */
function webBase(base: string): string {
  return base.replace(/\/+$/, '').replace(/^http:\/\//i, 'https://');
}

function projectOf(ctx: RunnerContext): string {
  if (!/^\d+$/.test(ctx.source.instance)) {
    throw new TandemiseError('PRECONDITION_FAILED', `Name this PostHog source's instance by its project id (a number), not '${ctx.source.instance}'.`);
  }
  return ctx.source.instance;
}

async function client(ctx: RunnerContext): Promise<SourceHttp> {
  const apiKey = await ctx.secrets.get('apiKey');
  if (apiKey === undefined || apiKey === '') throw new TandemiseError('PRECONDITION_FAILED', secretMissing(LABEL, 'personal API key'));
  return new SourceHttp({ label: LABEL, base: ctx.source.api ?? DEFAULT_API, token: apiKey, signal: ctx.signal });
}

const enc = encodeURIComponent;
