import type { IntegrationId } from '@tandemise/shared';
import type { ExternalRef } from '@tandemise/domain';
import { defineTool, type IntegrationTool } from '@tandemise/integrations-core';
import { z } from 'zod';
import { gh, ghJson } from './gh.js';
import { repoArgs, repoPositional, resolveRepo, type GitHubConfig } from './config.js';

/** Read capability for everything that only observes. MVP.md §12.5 keeps read and write separate. */
const READ = 'github.read';

const repoInput = z.string().optional()
  .describe('Repository as owner/name. Defaults to the integration default.');

const author = z.object({ login: z.string() }).nullable();

const prSummary = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  url: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  author,
  updatedAt: z.string(),
});

const issueSummary = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  url: z.string(),
  author,
  labels: z.array(z.object({ name: z.string() })),
  updatedAt: z.string(),
});

const PR_LIST_FIELDS = 'number,title,state,isDraft,url,headRefName,baseRefName,author,updatedAt';
const ISSUE_LIST_FIELDS = 'number,title,state,url,author,labels,updatedAt';

export function githubTools(
  integrationId: IntegrationId,
  config: GitHubConfig,
): readonly IntegrationTool[] {
  /** Every tool scopes to a repository, so extraction is uniform. */
  const repoOf = (input: { repo?: string }) => resolveRepo(config, input.repo);

  const repoView = defineTool({
    name: 'github.repo.view',
    integrationId,
    capability: READ,
    risk: 'read',
    description: 'Read a repository\'s metadata: description, default branch, visibility.',
    inputSchema: z.object({ repo: repoInput }),
    outputSchema: z.object({
      nameWithOwner: z.string(),
      description: z.string().nullable(),
      url: z.string(),
      defaultBranch: z.string(),
      isPrivate: z.boolean(),
      stargazerCount: z.number(),
    }),
    resource: repoOf,
    execute: async (ctx, input) => {
      const repo = repoOf(input);
      const raw = await ghJson(ctx, [
        'repo', 'view', ...repoPositional(repo),
        '--json', 'nameWithOwner,description,url,defaultBranchRef,isPrivate,stargazerCount',
      ], z.object({
        nameWithOwner: z.string(),
        description: z.string().nullable(),
        url: z.string(),
        defaultBranchRef: z.object({ name: z.string() }).nullable(),
        isPrivate: z.boolean(),
        stargazerCount: z.number(),
      }));
      const output = {
        nameWithOwner: raw.nameWithOwner,
        description: raw.description,
        url: raw.url,
        defaultBranch: raw.defaultBranchRef?.name ?? '',
        isPrivate: raw.isPrivate,
        stargazerCount: raw.stargazerCount,
      };
      return {
        output,
        summary: `${output.nameWithOwner} (default branch ${output.defaultBranch || 'unknown'})`,
        externalRefs: [{ kind: 'url', value: output.url, label: output.nameWithOwner }],
      };
    },
  });

  const prList = defineTool({
    name: 'github.pr.list',
    integrationId,
    capability: READ,
    risk: 'read',
    description: 'List pull requests in a repository.',
    inputSchema: z.object({
      repo: repoInput,
      state: z.enum(['open', 'closed', 'merged', 'all']).default('open'),
      limit: z.number().int().min(1).max(100).default(20),
      head: z.string().optional().describe('Filter to pull requests opened from this branch'),
      author: z.string().optional().describe('Filter by author login, or @me'),
    }),
    outputSchema: z.object({ pullRequests: z.array(prSummary) }),
    resource: repoOf,
    execute: async (ctx, input) => {
      const repo = repoOf(input);
      const pullRequests = await ghJson(ctx, [
        'pr', 'list', ...repoArgs(repo),
        '--state', input.state,
        '--limit', String(input.limit),
        ...(input.head ? ['--head', input.head] : []),
        ...(input.author ? ['--author', input.author] : []),
        '--json', PR_LIST_FIELDS,
      ], z.array(prSummary));
      return {
        output: { pullRequests },
        summary: `${pullRequests.length} ${input.state} pull request(s) in ${repo}`,
      };
    },
  });

  const prView = defineTool({
    name: 'github.pr.view',
    integrationId,
    capability: READ,
    risk: 'read',
    description: 'Read one pull request, including its body and diff statistics.',
    inputSchema: z.object({ repo: repoInput, number: z.number().int().positive() }),
    outputSchema: z.object({
      number: z.number(),
      title: z.string(),
      state: z.string(),
      isDraft: z.boolean(),
      url: z.string(),
      body: z.string(),
      headRefName: z.string(),
      baseRefName: z.string(),
      author,
      additions: z.number(),
      deletions: z.number(),
      changedFiles: z.number(),
      mergeable: z.string(),
      reviewDecision: z.string().nullable(),
    }),
    resource: repoOf,
    execute: async (ctx, input) => {
      const repo = repoOf(input);
      const output = await ghJson(ctx, [
        'pr', 'view', String(input.number), ...repoArgs(repo),
        '--json', 'number,title,state,isDraft,url,body,headRefName,baseRefName,author,additions,deletions,changedFiles,mergeable,reviewDecision',
      ], z.object({
        number: z.number(),
        title: z.string(),
        state: z.string(),
        isDraft: z.boolean(),
        url: z.string(),
        body: z.string(),
        headRefName: z.string(),
        baseRefName: z.string(),
        author,
        additions: z.number(),
        deletions: z.number(),
        changedFiles: z.number(),
        mergeable: z.string(),
        reviewDecision: z.string().nullable(),
      }));
      return {
        output,
        summary: `#${output.number} ${output.title} - ${output.state}, ${output.changedFiles} file(s) changed`,
        externalRefs: [{ kind: 'github.pr', value: output.url, label: `#${output.number}` }],
      };
    },
  });

  const issueList = defineTool({
    name: 'github.issue.list',
    integrationId,
    capability: READ,
    risk: 'read',
    description: 'List issues in a repository.',
    inputSchema: z.object({
      repo: repoInput,
      state: z.enum(['open', 'closed', 'all']).default('open'),
      limit: z.number().int().min(1).max(100).default(20),
      labels: z.array(z.string()).optional(),
    }),
    outputSchema: z.object({ issues: z.array(issueSummary) }),
    resource: repoOf,
    execute: async (ctx, input) => {
      const repo = repoOf(input);
      const issues = await ghJson(ctx, [
        'issue', 'list', ...repoArgs(repo),
        '--state', input.state,
        '--limit', String(input.limit),
        ...(input.labels?.length ? ['--label', input.labels.join(',')] : []),
        '--json', ISSUE_LIST_FIELDS,
      ], z.array(issueSummary));
      return { output: { issues }, summary: `${issues.length} ${input.state} issue(s) in ${repo}` };
    },
  });

  const issueView = defineTool({
    name: 'github.issue.view',
    integrationId,
    capability: READ,
    risk: 'read',
    description: 'Read one issue, including its body.',
    inputSchema: z.object({ repo: repoInput, number: z.number().int().positive() }),
    outputSchema: issueSummary.extend({ body: z.string() }),
    resource: repoOf,
    execute: async (ctx, input) => {
      const repo = repoOf(input);
      const output = await ghJson(ctx, [
        'issue', 'view', String(input.number), ...repoArgs(repo),
        '--json', `${ISSUE_LIST_FIELDS},body`,
      ], issueSummary.extend({ body: z.string() }));
      return {
        output,
        summary: `#${output.number} ${output.title} - ${output.state}`,
        externalRefs: [{ kind: 'github.issue', value: output.url, label: `#${output.number}` }],
      };
    },
  });

  const checksList = defineTool({
    name: 'github.checks.list',
    integrationId,
    capability: READ,
    risk: 'read',
    description: 'List CI check results for a pull request.',
    inputSchema: z.object({ repo: repoInput, number: z.number().int().positive() }),
    outputSchema: z.object({
      checks: z.array(z.object({
        name: z.string(),
        state: z.string(),
        bucket: z.string(),
        workflow: z.string().nullable(),
        link: z.string().nullable(),
      })),
      failing: z.number(),
      pending: z.number(),
    }),
    resource: repoOf,
    execute: async (ctx, input) => {
      const repo = repoOf(input);
      // Read through `gh pr view --json statusCheckRollup`, not `gh pr checks
      // --json`: that flag only exists in newer gh releases, and on gh 2.39 the
      // tool failed every call with "gh returned output that is not JSON" - a
      // release task could not tell whether CI was green.
      const view = await ghJson(ctx, [
        'pr', 'view', String(input.number), ...repoArgs(repo), '--json', 'statusCheckRollup',
      ], z.object({
        statusCheckRollup: z.array(z.object({
          __typename: z.string().optional(),
          name: z.string().optional(),
          context: z.string().optional(),
          status: z.string().nullable().optional(),
          conclusion: z.string().nullable().optional(),
          state: z.string().nullable().optional(),
          workflowName: z.string().nullable().optional(),
          detailsUrl: z.string().nullable().optional(),
          targetUrl: z.string().nullable().optional(),
        }).passthrough()).nullable().default([]),
      }));
      const checks = (view.statusCheckRollup ?? []).map((c) => {
        const result = (c.conclusion ?? c.state ?? '').toUpperCase();
        const done = c.__typename === 'StatusContext' ? result !== 'PENDING' && result !== 'EXPECTED' : c.status === 'COMPLETED';
        const bucket = !done ? 'pending'
          : ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(result) ? 'pass'
            : 'fail';
        return {
          name: c.name ?? c.context ?? 'check',
          state: done ? result || 'COMPLETED' : (c.status ?? result ?? 'PENDING').toUpperCase(),
          bucket,
          workflow: c.workflowName ?? null,
          link: c.detailsUrl ?? c.targetUrl ?? null,
        };
      });
      const failing = checks.filter((c) => c.bucket === 'fail').length;
      const pending = checks.filter((c) => c.bucket === 'pending').length;
      return {
        output: { checks, failing, pending },
        summary: `${checks.length} check(s) on #${input.number}: ${failing} failing, ${pending} pending`,
      };
    },
  });

  const prCreate = defineTool({
    name: 'github.pr.create',
    integrationId,
    capability: 'github.pr.create',
    risk: 'external_side_effect',
    description:
      'Open a draft pull request. If one already exists for the head branch, returns that one instead of creating a duplicate.',
    inputSchema: z.object({
      repo: repoInput,
      title: z.string().min(1),
      body: z.string().default(''),
      head: z.string().min(1).describe('Branch the changes are on'),
      base: z.string().optional().describe('Target branch. Defaults to the repository default.'),
      draft: z.boolean().default(true)
        .describe('Draft by default: a pull request opened by an agent is a proposal, not a request to merge.'),
    }),
    outputSchema: z.object({
      number: z.number(),
      url: z.string(),
      title: z.string(),
      state: z.string(),
      isDraft: z.boolean(),
      /** False when an existing pull request was returned instead. */
      created: z.boolean(),
    }),
    resource: repoOf,
    execute: async (ctx, input) => {
      const repo = repoOf(input);
      // Idempotency by natural key (MVP.md §21.3). A retried attempt - after a
      // crash, a timeout, or a recovered run - must converge on the same pull
      // request rather than leave a trail of duplicates for a human to clean up.
      const existing = await ghJson(ctx, [
        'pr', 'list', ...repoArgs(repo),
        '--head', input.head, '--state', 'all', '--limit', '1',
        '--json', 'number,title,state,isDraft,url',
      ], z.array(z.object({
        number: z.number(), title: z.string(), state: z.string(),
        isDraft: z.boolean(), url: z.string(),
      })));

      const found = existing[0];
      if (found) {
        return {
          output: { ...found, created: false },
          summary: `Pull request #${found.number} already exists for '${input.head}' (${found.state})`,
          externalRefs: [prRef(found.url, found.number)],
        };
      }

      await gh(ctx, [
        'pr', 'create', ...repoArgs(repo),
        '--head', input.head,
        ...(input.base ? ['--base', input.base] : []),
        '--title', input.title,
        '--body', input.body,
        ...(input.draft ? ['--draft'] : []),
      ]);

      // `gh pr create` prints the URL; re-read to return a shape identical to
      // the "already existed" branch, so a caller never has two cases to handle.
      const created = await ghJson(ctx, [
        'pr', 'view', input.head, ...repoArgs(repo),
        '--json', 'number,title,state,isDraft,url',
      ], z.object({
        number: z.number(), title: z.string(), state: z.string(),
        isDraft: z.boolean(), url: z.string(),
      }));
      return {
        output: { ...created, created: true },
        summary: `Opened ${created.isDraft ? 'draft ' : ''}pull request #${created.number} in ${repo}`,
        externalRefs: [prRef(created.url, created.number)],
      };
    },
  });

  const prComment = defineTool({
    name: 'github.pr.comment',
    integrationId,
    capability: 'github.pr.comment',
    risk: 'external_side_effect',
    description: 'Post a comment on a pull request.',
    inputSchema: z.object({
      repo: repoInput,
      number: z.number().int().positive(),
      body: z.string().min(1),
    }),
    outputSchema: z.object({ url: z.string() }),
    resource: repoOf,
    execute: async (ctx, input) => {
      const repo = repoOf(input);
      const result = await gh(ctx, [
        'pr', 'comment', String(input.number), ...repoArgs(repo), '--body', input.body,
      ]);
      const url = result.stdout.trim();
      return {
        output: { url },
        summary: `Commented on #${input.number} in ${repo}`,
        externalRefs: [{ kind: 'url', value: url, label: `comment on #${input.number}` }],
      };
    },
  });

  const issueCreate = defineTool({
    name: 'github.issue.create',
    integrationId,
    capability: 'github.issue.create',
    risk: 'external_side_effect',
    description: 'Open an issue.',
    inputSchema: z.object({
      repo: repoInput,
      title: z.string().min(1),
      body: z.string().default(''),
      labels: z.array(z.string()).optional(),
    }),
    outputSchema: z.object({ url: z.string(), number: z.number() }),
    resource: repoOf,
    execute: async (ctx, input) => {
      const repo = repoOf(input);
      const result = await gh(ctx, [
        'issue', 'create', ...repoArgs(repo),
        '--title', input.title,
        '--body', input.body,
        ...(input.labels?.length ? ['--label', input.labels.join(',')] : []),
      ]);
      const url = result.stdout.trim();
      const number = Number(url.split('/').pop());
      return {
        output: { url, number: Number.isFinite(number) ? number : 0 },
        summary: `Opened issue ${url}`,
        externalRefs: [{ kind: 'github.issue', value: url, label: input.title }],
      };
    },
  });

  return [
    repoView, prList, prView, issueList, issueView, checksList,
    prCreate, prComment, issueCreate,
  ] as readonly IntegrationTool[];
}

function prRef(url: string, number: number): ExternalRef {
  return { kind: 'github.pr', value: url, label: `#${number}` };
}
