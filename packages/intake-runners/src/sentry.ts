import { createHmac } from 'node:crypto';
import type {
  Closure, ClosureResult, Impact, ImpactLevel, IntakeRunner, RunnerContext, RunnerHandle, RunnerSignal, RunnerWebhookRequest,
} from '@tandemise/domain';
import { IMPACT_LEVELS } from '@tandemise/domain';
import { TandemiseError } from '@tandemise/shared';
import {
  MAX_DESCRIPTION, MAX_TITLE, SourceHttp, closureFailure, count, cut, header, isoTime, parseBody, record, sameText, secretMissing, text,
} from './http.js';

const LABEL = 'Sentry';
/** Plan Task 11: sentry.io unless the source names its own (self-hosted, or a fake). */
const DEFAULT_API = 'https://sentry.io';
/** Plan Task 11: what a webhook whose signature is not the client secret's throws. */
export const SENTRY_SIGNATURE_MISMATCH = "The Sentry signature doesn't match.";

/**
 * Sentry as an intake runner (spec §2, §8; plan Task 11). The source's
 * instance is `<org>/<project>`; the secrets are `token` (an auth token, for
 * the poll and for resolving) and `clientSecret` (the integration's, for
 * webhooks). Each poll lists the project's unresolved issues seen in the last
 * 24 h and pushes one signal per issue: what to keep is the noise filter's
 * call (spec §4.1), so a 3-event issue is held back and the same issue at
 * 300 events passes on a later poll.
 */
export class SentryRunner implements IntakeRunner {
  readonly kind = 'sentry';
  readonly mode = 'poll' as const;
  /** Where the source's secrets go when it sets no `api` (Ruling 23). */
  readonly defaultApi = DEFAULT_API;

  start(ctx: RunnerContext): RunnerHandle {
    return {
      poll: async () => {
        const { org, project } = instanceOf(ctx);
        const http = await client(ctx);
        const issues = await http.getJson(`/api/0/projects/${enc(org)}/${enc(project)}/issues/`, { query: 'is:unresolved', statsPeriod: '24h' });
        for (const issue of Array.isArray(issues) ? issues : []) {
          if (ctx.signal.aborted) return;
          const signal = issueSignal(ctx.source.instance, issue);
          if (signal !== null) await ctx.push(signal);
        }
      },
      stop: async () => {},
    };
  }

  /**
   * Spec §8: resolve in the fixing commit when the commit and its repository
   * are known and Sentry lists that repository for the organization, else
   * resolve in the next release. A won't-do item writes nothing (RULINGS
   * ruling 17). A regression reopens the issue in Sentry, and the next poll
   * reads it again as the same fingerprint.
   */
  async close(closure: Closure, ctx: RunnerContext): Promise<ClosureResult> {
    if (closure.kind !== 'done') return { ok: true, externalId: null };
    try {
      const { org } = instanceOf(ctx);
      const http = await client(ctx);
      let statusDetails: Record<string, unknown> = { inNextRelease: true };
      if (closure.commit !== null) {
        const repos = await http.getJson(`/api/0/organizations/${enc(org)}/repos/`);
        const wanted = closure.commit.repo.toLowerCase();
        const linked = (Array.isArray(repos) ? repos : []).some((r) => text(record(r)['name'])?.toLowerCase() === wanted);
        if (linked) statusDetails = { inCommit: { commit: closure.commit.sha, repository: closure.commit.repo } };
      }
      await http.sendJson('PUT', `/api/0/issues/${enc(closure.signal.key)}/`, { status: 'resolved', statusDetails });
      return { ok: true, externalId: closure.signal.key };
    } catch (e) {
      return closureFailure(e);
    }
  }

  /**
   * A Sentry integration webhook (spec §2 "Webhook-only sources"): the
   * `Sentry-Hook-Signature` header is the HMAC-SHA256 (hex) of the body's
   * exact bytes with the integration's client secret. Only issue payloads
   * carry a signal; any other resource answers none.
   */
  async fromWebhook(req: RunnerWebhookRequest, ctx: RunnerContext): Promise<readonly RunnerSignal[]> {
    const secret = await ctx.secrets.get('clientSecret');
    if (secret === undefined || secret === '') throw new TandemiseError('PRECONDITION_FAILED', secretMissing(LABEL, 'client secret'));
    const given = header(req.headers, 'sentry-hook-signature') ?? '';
    const expected = createHmac('sha256', secret).update(req.body).digest('hex');
    if (!sameText(given, expected)) throw new TandemiseError('PERMISSION_DENIED', SENTRY_SIGNATURE_MISMATCH);
    const issue = record(record(parseBody(req.body, LABEL))['data'])['issue'];
    if (issue === undefined) return [];
    const signal = issueSignal(ctx.source.instance, issue);
    return signal === null ? [] : [signal];
  }
}

/** One Sentry issue (from the API or a webhook) as a `tandemise.intake/v1` signal; null when it has no id, link or title. */
export function issueSignal(instance: string, raw: unknown): RunnerSignal | null {
  const issue = record(raw);
  const key = text(issue['id']);
  const url = text(issue['permalink']) ?? text(issue['web_url']);
  const title = text(issue['title']);
  if (key === undefined || url === undefined || title === undefined) return null;
  const description = [text(issue['culprit']), text(record(issue['metadata'])['value'])].filter((s) => s !== undefined).join('\n\n');
  const impact = issueImpact(issue);
  return {
    schema: 'tandemise.intake/v1',
    source: { kind: 'sentry', instance },
    key,
    url,
    title: cut(title, MAX_TITLE),
    ...(description === '' ? {} : { description: cut(description, MAX_DESCRIPTION) }),
    ...(Object.keys(impact).length === 0 ? {} : { impact }),
    kindHint: 'bug',
  };
}

/** Plan Task 11: `{ level, events: Number(count), users: userCount, firstSeen, lastSeen }`, each only when Sentry gave it. */
function issueImpact(issue: Readonly<Record<string, unknown>>): Impact {
  const level = text(issue['level']);
  const events = count(issue['count']);
  const users = count(issue['userCount']);
  const firstSeen = isoTime(issue['firstSeen']);
  const lastSeen = isoTime(issue['lastSeen']);
  return {
    // Sentry's `debug` and `sample` levels have no place on the contract's scale and are left out.
    ...(level !== undefined && (IMPACT_LEVELS as readonly string[]).includes(level) ? { level: level as ImpactLevel } : {}),
    ...(events === undefined ? {} : { events }),
    ...(users === undefined ? {} : { users }),
    ...(firstSeen === undefined ? {} : { firstSeen }),
    ...(lastSeen === undefined ? {} : { lastSeen }),
  };
}

function instanceOf(ctx: RunnerContext): { org: string; project: string } {
  const [org, project, ...rest] = ctx.source.instance.split('/');
  if (org === undefined || org === '' || project === undefined || project === '' || rest.length > 0) {
    throw new TandemiseError('PRECONDITION_FAILED', `Name this Sentry source's instance as <organization>/<project>, not '${ctx.source.instance}'.`);
  }
  return { org, project };
}

async function client(ctx: RunnerContext): Promise<SourceHttp> {
  const token = await ctx.secrets.get('token');
  if (token === undefined || token === '') throw new TandemiseError('PRECONDITION_FAILED', secretMissing(LABEL, 'auth token'));
  return new SourceHttp({ label: LABEL, base: ctx.source.api ?? DEFAULT_API, token, signal: ctx.signal });
}

const enc = encodeURIComponent;
