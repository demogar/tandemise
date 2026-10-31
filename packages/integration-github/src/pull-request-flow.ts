import { z } from 'zod';
import type { PullRequestChecks, PullRequestPort, PullRequestRef } from '@tandemise/domain';
import type { CommandExecutor } from '@tandemise/integrations-core';
import { TandemiseError } from '@tandemise/shared';
import { gh, ghJson, type GhContext } from './gh.js';

/**
 * The ship step's pull requests (#53 §8), through `gh` as every GitHub call
 * is: Tandemise stores no GitHub credential and uses the starting member's own
 * `gh` session. Merging is always bound to the decided head commit with
 * `--match-head-commit`, so GitHub itself refuses a merge of anything pushed
 * after the decision.
 */
const PR_FIELDS = 'number,url,title,headRefOid,headRefName,baseRefName,state,isDraft,mergedBy,mergeCommit';

const prSchema = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string().optional(),
  headRefOid: z.string().optional(),
  headRefName: z.string().optional(),
  baseRefName: z.string().optional(),
  state: z.string(),
  isDraft: z.boolean().optional(),
  mergedBy: z.object({ login: z.string() }).nullable().optional(),
  mergeCommit: z.object({ oid: z.string() }).nullable().optional(),
});

/** Lines of a failing check's output kept for the round's note. */
const LOG_TAIL_LINES = 40;

function toRef(repo: string, pr: z.infer<typeof prSchema>): PullRequestRef {
  const state = pr.state.toUpperCase();
  return {
    repo,
    number: pr.number,
    url: pr.url,
    title: pr.title ?? '',
    headSha: pr.headRefOid ?? '',
    headBranch: pr.headRefName ?? '',
    baseBranch: pr.baseRefName ?? '',
    state: state === 'MERGED' ? 'MERGED' : state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    isDraft: pr.isDraft ?? false,
    mergedBy: pr.mergedBy?.login ?? null,
    mergeSha: pr.mergeCommit?.oid ?? null,
  };
}

export class GhPullRequestFlow implements PullRequestPort {
  constructor(private readonly exec: CommandExecutor) {}

  #ctx(cwd: string): GhContext {
    return { exec: this.exec, workingDirectory: cwd };
  }

  async open(input: { cwd: string; repo: string; head: string; base: string; title: string; body: string }): Promise<PullRequestRef & { created: boolean }> {
    const existing = await this.#byHead(input.cwd, input.repo, input.head);
    if (existing !== null) return { ...existing, created: false };
    await gh(this.#ctx(input.cwd), [
      'pr', 'create', '--repo', input.repo, '--head', input.head, '--base', input.base, '--title', input.title, '--body-file', '-',
    ], { stdin: input.body });
    const made = await this.#byHead(input.cwd, input.repo, input.head);
    if (made === null) throw new TandemiseError('INTEGRATION_FAILED', `gh opened a pull request for ${input.head}, but it can't be found.`);
    return { ...made, created: true };
  }

  async #byHead(cwd: string, repo: string, head: string): Promise<PullRequestRef | null> {
    const rows = await ghJson(this.#ctx(cwd), ['pr', 'list', '--repo', repo, '--head', head, '--state', 'all', '--json', PR_FIELDS], z.array(prSchema));
    const live = rows.map((r) => toRef(repo, r)).filter((r) => r.state !== 'CLOSED').sort((a, b) => b.number - a.number);
    return live[0] ?? null;
  }

  async listByHead(cwd: string, repo: string, head: string): Promise<readonly (PullRequestRef & { body: string })[]> {
    const rows = await ghJson(this.#ctx(cwd), ['pr', 'list', '--repo', repo, '--head', head, '--state', 'all', '--json', `${PR_FIELDS},body`], z.array(prSchema.extend({ body: z.string().optional() })));
    return rows.map((r) => ({ ...toRef(repo, r), body: r.body ?? '' }));
  }

  async view(cwd: string, repo: string, number: number): Promise<PullRequestRef> {
    return toRef(repo, await ghJson(this.#ctx(cwd), ['pr', 'view', String(number), '--repo', repo, '--json', PR_FIELDS], prSchema));
  }

  async checks(cwd: string, repo: string, sha: string): Promise<PullRequestChecks> {
    const runs = await ghJson(this.#ctx(cwd), ['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`], z.object({
      check_runs: z.array(z.object({
        name: z.string(),
        status: z.string(),
        conclusion: z.string().nullable().optional(),
        details_url: z.string().nullable().optional(),
        output: z.object({ summary: z.string().nullable().optional(), text: z.string().nullable().optional() }).nullable().optional(),
      }).passthrough()).optional(),
    }));
    const all = runs.check_runs ?? [];
    const done = all.filter((r) => r.status.toLowerCase() === 'completed');
    const failing = done.filter((r) => !['success', 'neutral', 'skipped'].includes((r.conclusion ?? '').toLowerCase()));
    const state: PullRequestChecks['state'] = all.length === 0 ? 'NONE'
      : failing.length > 0 ? 'FAIL'
        : done.length < all.length ? 'PENDING' : 'PASS';
    return {
      state,
      done: done.length,
      total: all.length,
      failing: failing.map((r) => {
        const text = [r.output?.summary, r.output?.text].filter((t): t is string => typeof t === 'string' && t.length > 0).join('\n');
        return { name: r.name, link: r.details_url ?? null, logTail: text.length === 0 ? null : text.split('\n').slice(-LOG_TAIL_LINES).join('\n') };
      }),
    };
  }

  async protection(cwd: string, repo: string, branch: string): Promise<{ requiredChecks: boolean | null; reviewRequired: boolean | null; upToDate: boolean | null }> {
    const result = await gh(this.#ctx(cwd), ['api', `repos/${repo}/branches/${branch}/protection`], { tolerateExitCodes: [1] });
    if (result.exitCode !== 0) {
      // A 404 is "not protected"; anything else is "could not tell", which never passes a rule.
      return /404|Not Found|not protected/i.test(`${result.stderr}${result.stdout}`)
        ? { requiredChecks: false, reviewRequired: false, upToDate: false }
        : { requiredChecks: null, reviewRequired: null, upToDate: null };
    }
    try {
      const p = JSON.parse(result.stdout) as {
        required_status_checks?: { strict?: boolean; contexts?: string[]; checks?: unknown[] } | null;
        required_pull_request_reviews?: { required_approving_review_count?: number } | null;
      };
      const checks = p.required_status_checks ?? null;
      return {
        requiredChecks: checks !== null && ((checks.contexts?.length ?? 0) + (checks.checks?.length ?? 0)) > 0,
        reviewRequired: (p.required_pull_request_reviews?.required_approving_review_count ?? (p.required_pull_request_reviews ? 1 : 0)) > 0,
        upToDate: checks?.strict === true,
      };
    } catch {
      return { requiredChecks: null, reviewRequired: null, upToDate: null };
    }
  }

  async comment(cwd: string, repo: string, number: number, body: string, existingId: number | null): Promise<{ id: number }> {
    const args = existingId === null
      ? ['api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`, '-f', `body=${body}`]
      : ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existingId}`, '-f', `body=${body}`];
    return ghJson(this.#ctx(cwd), args, z.object({ id: z.number() }).passthrough());
  }

  async requestReviewers(cwd: string, repo: string, number: number, reviewers: readonly string[]): Promise<void> {
    if (reviewers.length === 0) return;
    await gh(this.#ctx(cwd), ['pr', 'edit', String(number), '--repo', repo, ...reviewers.flatMap((r) => ['--add-reviewer', r])]);
  }

  async reviews(cwd: string, repo: string, number: number): Promise<readonly { state: string; author: string }[]> {
    const view = await ghJson(this.#ctx(cwd), ['pr', 'view', String(number), '--repo', repo, '--json', 'reviews'], z.object({
      reviews: z.array(z.object({ state: z.string(), author: z.object({ login: z.string() }).nullable().optional() })).optional(),
    }));
    return (view.reviews ?? []).map((r) => ({ state: r.state, author: r.author?.login ?? '' }));
  }

  async merge(cwd: string, repo: string, number: number, opts: { method: 'squash' | 'merge' | 'rebase'; matchHeadCommit: string; auto: boolean; subject: string; body: string }): Promise<{ merged: boolean; queued: boolean; refused: string | null }> {
    const result = await gh(this.#ctx(cwd), [
      'pr', 'merge', String(number), '--repo', repo, `--${opts.method}`, '--match-head-commit', opts.matchHeadCommit,
      ...(opts.auto ? ['--auto'] : []), '--subject', opts.subject, '--body', opts.body,
    ], { tolerateExitCodes: [1] });
    if (result.exitCode !== 0) return { merged: false, queued: false, refused: (result.stderr || result.stdout).split('\n')[0] ?? 'refused' };
    return { merged: !opts.auto, queued: opts.auto, refused: null };
  }

  async disableAutoMerge(cwd: string, repo: string, number: number): Promise<void> {
    await gh(this.#ctx(cwd), ['pr', 'merge', String(number), '--repo', repo, '--disable-auto']);
  }

  async updateBranch(cwd: string, repo: string, number: number): Promise<void> {
    await gh(this.#ctx(cwd), ['pr', 'update-branch', String(number), '--repo', repo]);
  }

  async repoSettings(cwd: string, repo: string): Promise<{ allowAutoMerge: boolean }> {
    const view = await ghJson(this.#ctx(cwd), ['repo', 'view', repo, '--json', 'autoMergeAllowed'], z.object({ autoMergeAllowed: z.boolean().optional() }));
    return { allowAutoMerge: view.autoMergeAllowed === true };
  }

  async commits(cwd: string, repo: string, branch: string, sinceIso: string): Promise<readonly { sha: string; subject: string }[]> {
    const rows = await ghJson(this.#ctx(cwd), ['api', `repos/${repo}/commits?sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(sinceIso)}&per_page=100`], z.array(z.object({
      sha: z.string(), commit: z.object({ message: z.string() }),
    }).passthrough()));
    return rows.map((r) => ({ sha: r.sha, subject: r.commit.message.split('\n')[0] ?? '' }));
  }
}
