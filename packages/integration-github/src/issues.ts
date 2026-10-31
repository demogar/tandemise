import { z } from 'zod';
import type { IssueTrackerPort, UpstreamComment, UpstreamIssue } from '@tandemise/domain';
import { splitGithubRepo } from '@tandemise/domain';
import { TandemiseError } from '@tandemise/shared';
import type { CommandExecutor } from '@tandemise/integrations-core';
import { gh, ghJson, type GhContext } from './gh.js';

const ISSUE_FIELDS = 'number,title,body,url,updatedAt,labels,author,state';
const LIST_FIELDS = 'number,title,body,url,updatedAt,labels,author';

const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  url: z.string(),
  updatedAt: z.string(),
  labels: z.array(z.object({ name: z.string() }).passthrough()).optional(),
  // A deleted account comes back as null ("ghost").
  author: z.object({ login: z.string() }).passthrough().nullable().optional(),
  state: z.string().optional(),
}).passthrough();

const commentSchema = z.object({
  id: z.union([z.number(), z.string()]),
  body: z.string().nullable().optional(),
  user: z.object({ login: z.string() }).passthrough().nullable().optional(),
}).passthrough();

/**
 * The top-level JSON values of `gh api --paginate`'s output: one per page,
 * printed back to back (`[…][…]`), so not one JSON document. Splits on depth,
 * minding strings, then parses each.
 */
function jsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        values.push(parseJson(text.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  if (depth !== 0 || (values.length === 0 && text.trim() !== '')) {
    throw new TandemiseError('INTEGRATION_FAILED', `gh returned output that is not JSON: ${text.slice(0, 200)}`);
  }
  return values;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new TandemiseError('INTEGRATION_FAILED', `gh returned output that is not JSON: ${text.slice(0, 200)}`);
  }
}

function toIssue(raw: z.infer<typeof issueSchema>, fallbackState: 'OPEN' | 'CLOSED'): UpstreamIssue {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    url: raw.url,
    updatedAt: raw.updatedAt,
    labels: (raw.labels ?? []).map((l) => l.name),
    author: raw.author?.login ?? null,
    state: raw.state === undefined ? fallbackState : raw.state.toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
  };
}

/**
 * GitHub issues over the `gh` CLI (P14 spec §4).
 *
 * The same transport and error words as the GitHub tools: `gh`'s own sign-in
 * is the only credential, and a failure reads "The GitHub CLI is not
 * authenticated. Run `gh auth login`." rather than an exit code. Every call
 * names the repository explicitly (`--repo`, or the API path) so a checkout
 * with an unexpected remote can never redirect it.
 */
export class GhIssueTracker implements IssueTrackerPort {
  constructor(private readonly exec: CommandExecutor, private readonly timeoutMs = 60_000) {}

  async listOpen(query: { repo: string; label: string; limit: number; cwd?: string }): Promise<readonly UpstreamIssue[]> {
    const rows = await ghJson(this.#ctx(query.cwd), [
      'issue', 'list', '--repo', query.repo, '--label', query.label, '--state', 'open',
      '--limit', String(query.limit), '--json', LIST_FIELDS,
    ], z.array(issueSchema), { timeoutMs: this.timeoutMs });
    return rows.map((r) => toIssue(r, 'OPEN'));
  }

  async view(query: { repo: string; number: number; cwd?: string }): Promise<UpstreamIssue> {
    const raw = await ghJson(this.#ctx(query.cwd), [
      'issue', 'view', String(query.number), '--repo', query.repo, '--json', ISSUE_FIELDS,
    ], issueSchema, { timeoutMs: this.timeoutMs });
    return toIssue(raw, 'OPEN');
  }

  async viewer(query: { repo: string; cwd?: string }): Promise<string> {
    const me = await ghJson(this.#ctx(query.cwd), ['api', ...this.#host(query.repo), 'user'], z.object({ login: z.string() }).passthrough(), { timeoutMs: this.timeoutMs });
    return me.login;
  }

  /**
   * Every comment, page by page (`--paginate`): a marker comment past the
   * first 100 must still be found, or it would be posted again (Ruling 26).
   * gh prints each page as its own JSON array, back to back.
   */
  async comments(query: { repo: string; number: number; cwd?: string }): Promise<readonly UpstreamComment[]> {
    const { path } = splitGithubRepo(query.repo);
    const result = await gh(this.#ctx(query.cwd), [
      'api', ...this.#host(query.repo), '--paginate', `repos/${path}/issues/${query.number}/comments?per_page=100`,
    ], { timeoutMs: this.timeoutMs });
    const rows: z.infer<typeof commentSchema>[] = [];
    for (const page of jsonValues(result.stdout)) {
      const parsed = z.array(commentSchema).safeParse(page);
      if (!parsed.success) {
        throw new TandemiseError('INTEGRATION_FAILED',
          `Unexpected gh response shape: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          { details: { command: result.command } });
      }
      rows.push(...parsed.data);
    }
    return rows.map((c) => ({ id: String(c.id), author: c.user?.login ?? null, body: c.body ?? '' }));
  }

  async postComment(query: { repo: string; number: number; body: string; cwd?: string }): Promise<string> {
    const { path } = splitGithubRepo(query.repo);
    // `-f` sends the body as a raw string: no file expansion, no shell.
    const made = await ghJson(this.#ctx(query.cwd), [
      'api', ...this.#host(query.repo), '-X', 'POST', `repos/${path}/issues/${query.number}/comments`, '-f', `body=${query.body}`,
    ], commentSchema, { timeoutMs: this.timeoutMs });
    return String(made.id);
  }

  async updateComment(query: { repo: string; commentId: string; body: string; cwd?: string }): Promise<void> {
    const { path } = splitGithubRepo(query.repo);
    await gh(this.#ctx(query.cwd), [
      'api', ...this.#host(query.repo), '-X', 'PATCH', `repos/${path}/issues/comments/${query.commentId}`, '-f', `body=${query.body}`,
    ], { timeoutMs: this.timeoutMs });
  }

  /** `reason` is gh's own (intake's GitHub runner closes a won't-do item as "not planned"); unset, gh's default. */
  async close(query: { repo: string; number: number; cwd?: string; reason?: 'completed' | 'not planned' }): Promise<void> {
    await gh(this.#ctx(query.cwd), [
      'issue', 'close', String(query.number), '--repo', query.repo, ...(query.reason === undefined ? [] : ['--reason', query.reason]),
    ], { timeoutMs: this.timeoutMs });
  }

  #ctx(cwd: string | undefined): GhContext {
    return { exec: this.exec, ...(cwd === undefined ? {} : { workingDirectory: cwd }) };
  }

  /** `gh api` reads the host from `--hostname`; `--repo` takes `host/owner/name` itself. */
  #host(repo: string): readonly string[] {
    const { host } = splitGithubRepo(repo);
    return host === null ? [] : ['--hostname', host];
  }
}
