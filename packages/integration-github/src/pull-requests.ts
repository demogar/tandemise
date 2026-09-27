import { z } from 'zod';
import type { PullRequestSnapshot, PullRequestSnapshotPort } from '@tandemise/domain';
import type { CommandExecutor } from '@tandemise/integrations-core';
import { TandemiseError } from '@tandemise/shared';
import { gh, ghJson, type GhContext } from './gh.js';

/** Only a github.com pull request URL is ever handed to `gh`; anything else is not ours to read. */
const PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

/**
 * A diff past this is cut. The whole diff becomes an Evidence body that a
 * later step reads into a prompt, and a generated-file PR can run to tens of
 * megabytes; 2 MB is far more than a reviewer reads and far less than that.
 */
const DIFF_MAX_BYTES = 2 * 1024 * 1024;
const TRUNCATED_NOTE = '… diff truncated at 2 MB';

/** What gh prints for a pull request or repository that does not exist, or that this account cannot see. */
const MISSING = /Could not resolve to a (PullRequest|Repository)/i;

const viewSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  headRefName: z.string(),
  headRefOid: z.string(),
  url: z.string(),
}).passthrough();

/**
 * Reads a handed-back GitHub pull request over the `gh` CLI (spec A4).
 *
 * The same transport as the issue tracker, so `gh`'s own sign-in is the only
 * credential. A PR this machine cannot see is not an error: the caller falls
 * back to an attached export, or tells the person to attach one.
 */
export class GhPullRequestSnapshots implements PullRequestSnapshotPort {
  constructor(private readonly exec: CommandExecutor, private readonly timeoutMs = 60_000) {}

  async read(url: string, cwd: string): Promise<PullRequestSnapshot | null> {
    const match = PR_URL.exec(url);
    if (match === null) return null;
    const ctx: GhContext = { exec: this.exec, workingDirectory: cwd };
    try {
      const view = await ghJson(ctx, ['pr', 'view', url, '--json', 'number,title,body,headRefName,headRefOid,url'], viewSchema, { timeoutMs: this.timeoutMs });
      const diff = await gh(ctx, ['pr', 'diff', url], { timeoutMs: this.timeoutMs });
      return {
        url: view.url,
        number: view.number,
        repo: `${match[1]}/${match[2]}`,
        headRefName: view.headRefName,
        headRefOid: view.headRefOid,
        title: view.title,
        body: view.body ?? '',
        diff: capDiff(diff.stdout),
      };
    } catch (e) {
      // Not found and no access read the same to the person: nothing here can
      // read that link. Anything else (gh missing, signed out, a timeout) is a
      // real failure they can fix, so it is not hidden behind a null.
      if (e instanceof TandemiseError && (e.code === 'NOT_FOUND' || e.code === 'PERMISSION_DENIED')) return null;
      // gh reports a missing pull request as a GraphQL error with no "Not
      // Found" in it, which the shared failure words leave as a plain exit;
      // matched here rather than there so the issue tracker's errors keep
      // their meaning.
      if (e instanceof Error && MISSING.test(e.message)) return null;
      throw e;
    }
  }
}

/** Cuts at the last whole line under the cap, so the diff never ends mid-hunk-line. */
function capDiff(diff: string): string {
  const bytes = Buffer.from(diff, 'utf8');
  if (bytes.byteLength <= DIFF_MAX_BYTES) return diff;
  const head = bytes.subarray(0, DIFF_MAX_BYTES).toString('utf8');
  const lastLine = head.lastIndexOf('\n');
  return `${lastLine > 0 ? head.slice(0, lastLine + 1) : `${head}\n`}${TRUNCATED_NOTE}`;
}
