import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ArtifactRepositoryPort, ArtifactStorePort, ExternalRef, MemberRepositoryPort, Mission,
  MissionRepositoryPort, OutsideContribution, PullRequestSnapshot, PullRequestSnapshotPort, RepoRepositoryPort, Repository,
} from '@tandemise/domain';
import { CONTRIBUTION_MAX_BYTES, decodedSize } from '@tandemise/domain';
import type { CommandExecutor } from '@tandemise/integrations-core';
import type { MissionId, TaskId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, isPathInside } from '@tandemise/shared';
import { actorFor, type Caller } from '../support/identity.js';
import type { ContributionService, PinnedContribution } from '../services.js';

export type ContributionErrorCode = 'unreadable_link' | 'too_large' | 'empty' | 'outside_workspace' | 'unfetchable_pull_request';

/**
 * A contribution this machine will not take, in words the person can act on.
 * Its own class rather than a `TandemiseError` so each caller (intake, hand-back,
 * feedback, the routes) can map the code to its own response.
 */
export class ContributionError extends Error {
  constructor(readonly code: ContributionErrorCode, message: string) {
    super(message);
    this.name = 'ContributionError';
  }
}

/** Evidence titles show in one line of a card; a long filename is cut to fit. */
const TITLE_MAX = 60;

/** A fetch of one pull request's head: long enough for a slow network, short enough not to hold a hand-back open. */
const FETCH_TIMEOUT_MS = 60_000;

/** The local branch a handed-back pull request's head is fetched into, so it exists wherever the work runs next. */
export function pullRequestBranch(number: number): string {
  return `tandemise/pr-${number}`;
}

export interface ContributionDeps {
  readonly missions: MissionRepositoryPort;
  readonly repositories: RepoRepositoryPort;
  readonly members: MemberRepositoryPort;
  readonly artifactStore: ArtifactStorePort;
  readonly artifacts: ArtifactRepositoryPort;
  readonly snapshots: PullRequestSnapshotPort;
  /** The workspace's artifact root, the one place outside a repository a workspace link may point. */
  readonly artifactRoot: (workspaceId: WorkspaceId) => string;
  /**
   * Runs `git` to fetch a handed-back pull request's head into the checkout
   * that read it. Null in a build without one, which then records no branch.
   */
  readonly exec?: CommandExecutor | null;
  /**
   * What the person's git needs to reach a remote on their behalf (an
   * ssh-agent socket, an askpass helper), added to the fetch alone. The tool
   * runner's environment is an allowlist that drops them, and widening it
   * would hand them to every agent tool too.
   */
  readonly credentialEnv?: () => Readonly<Record<string, string>>;
}

/** The variables a user's git reads to authenticate without a prompt. */
const GIT_CREDENTIAL_VARIABLES = ['SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SSH_ASKPASS'] as const;

/** The credential variables set in `ambient`, for `ContributionDeps.credentialEnv`. */
export function pickGitCredentialEnv(ambient: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const key of GIT_CREDENTIAL_VARIABLES) {
    const value = ambient[key];
    if (value !== undefined && value.length > 0) out[key] = value;
  }
  return out;
}

type GitRun = (args: readonly string[]) => Promise<{ exitCode: number; stdout: string }>;

/** What a contribution becomes on disk before it is pinned. */
interface Snapshot {
  readonly title: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly body: string | Uint8Array;
  readonly refs: (contentRef: string) => readonly ExternalRef[];
  readonly resolved: PullRequestSnapshot | null;
  readonly repositoryPath: string | null;
}

/**
 * Pins what is handed in from outside a mission as Evidence (spec A1).
 *
 * Every entry point (an upload at creation, a feedback attachment, a
 * hand-back) comes through `pin`, so a contribution is always the same
 * immutable, content-addressed snapshot with the same refs, whatever typed
 * artifact is later made from it.
 */
export class ContributionServiceImpl implements ContributionService {
  constructor(private readonly deps: ContributionDeps) {}

  async pin(input: {
    missionId: MissionId; taskId?: TaskId | null; caller: Caller; onBehalfOf?: string | null; contribution: OutsideContribution;
    requireBranch?: boolean;
  }): Promise<PinnedContribution> {
    const mission = this.deps.missions.get(input.missionId);
    if (mission === undefined) throw TandemiseError.notFound('Mission', input.missionId);
    // Checked before anything is read or written, so a refused contribution
    // from someone without a seat never costs a `gh` call or a blob.
    const { actorId, recordedBy } = actorFor(this.deps, mission.workspaceId, input.caller, input.onBehalfOf ?? undefined);
    const snapshot = await this.#snapshot(mission, input.contribution, input.requireBranch === true);

    const written = await this.deps.artifactStore.write({
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      taskId: input.taskId ?? null,
      type: 'Evidence',
      title: snapshot.title,
      body: snapshot.body,
      mediaType: snapshot.mediaType,
    });
    // The file ref names the stored blob, which is only known once written;
    // the manifest table, not the store's sidecar, is what everything reads.
    const evidence = this.deps.artifacts.create({
      ...written,
      sourceRefs: snapshot.refs(written.contentRef),
      authorId: actorId,
      recordedBy,
      responsibleId: null,
    });
    return { evidence, filename: snapshot.filename, mediaType: snapshot.mediaType, resolved: snapshot.resolved, repositoryPath: snapshot.repositoryPath };
  }

  async resolveWorkspacePath(workspaceId: WorkspaceId, path: string): Promise<string> {
    const outside = new ContributionError('outside_workspace', `'${path}' is not inside this project's repositories or artifacts.`);
    // Refused before anything touches the disk: a `..` is never a legitimate
    // way to name something inside a root, whatever it would resolve to.
    if (path.split(/[\\/]/).includes('..')) throw outside;
    const roots = [...this.deps.repositories.listByWorkspace(workspaceId).map((r) => r.path), this.deps.artifactRoot(workspaceId)];
    for (const root of roots) {
      // Both sides through realpath, so a symlink inside a root that points
      // out of it is judged by where it lands, and a root that is itself
      // reached through a link (macOS's /var, /tmp) still contains its files.
      const realRoot = await realpathOrNull(root);
      const target = await realpathOrNull(join(root, path));
      if (realRoot !== null && target !== null && isPathInside(realRoot, target)) return target;
    }
    throw outside;
  }

  async #snapshot(mission: Mission, contribution: OutsideContribution, requireBranch: boolean): Promise<Snapshot> {
    if (contribution.kind === 'file') {
      const body = decode(contribution.dataBase64);
      return {
        title: fitTitle(contribution.filename),
        filename: contribution.filename,
        mediaType: contribution.mediaType,
        body,
        refs: (contentRef) => [{ kind: 'file', value: contentRef, label: contribution.filename }],
        resolved: null,
        repositoryPath: null,
      };
    }
    const { url } = contribution;
    const { snapshot: resolved, failure, repository } = await this.#resolve(mission, url);
    // A resolver that failed outright (gh signed out, say) on every repository
    // must not stop a person who attached an export from handing it in;
    // without one, the failure is the most useful thing to tell them.
    if (resolved === null && failure !== null && contribution.export === undefined) throw failure;
    if (resolved !== null && repository !== null) {
      const pr = resolved;
      // The head is fetched before anything is written: a change handed back
      // with no branch here would have nothing for review, QA or integration
      // to check out, so it is refused while there is still nothing to undo.
      const head = await this.#localHead(mission, pr);
      if (head.branch === null && requireBranch) {
        throw new ContributionError(
          'unfetchable_pull_request',
          `Couldn't fetch that pull request into ${head.into}. Fetch or push its branch, then hand it back again.`,
        );
      }
      const branch = head.branch;
      return {
        title: fitTitle(contribution.label ?? pr.title),
        filename: `pull-request-${pr.number}.md`,
        mediaType: 'text/markdown',
        // The fence is sized over the body too: a body that shows a code
        // block must not be the thing that closes the diff's.
        body: `# ${pr.title}\n\n${pr.body}\n\n## Diff\n\n${fenced('diff', pr.diff, pr.body)}`,
        refs: () => [
          { kind: 'url', value: url },
          { kind: 'github.pr', value: `${pr.repo}#${pr.number}` },
          { kind: 'git.commit', value: pr.headRefOid },
          ...(branch === null ? [] : [{ kind: 'git.branch' as const, value: branch }]),
        ],
        resolved: pr,
        repositoryPath: head.repository?.path ?? null,
      };
    }
    const exported = contribution.export;
    if (exported === undefined) {
      throw new ContributionError('unreadable_link', 'Nothing here can read that link. Attach an export of it.');
    }
    return {
      title: fitTitle(contribution.label ?? exported.filename),
      filename: exported.filename,
      mediaType: exported.mediaType,
      body: decode(exported.dataBase64),
      refs: (contentRef) => [{ kind: 'url', value: url }, { kind: 'file', value: contentRef, label: exported.filename }],
      resolved: null,
      repositoryPath: null,
    };
  }

  /**
   * The workspace's repositories, the mission's own first: it is where a
   * pull request handed back to the mission most likely belongs.
   */
  #repositoriesFor(mission: Mission): readonly Repository[] {
    const all = this.deps.repositories.listByWorkspace(mission.workspaceId);
    return [...all.filter((r) => r.id === mission.repositoryId), ...all.filter((r) => r.id !== mission.repositoryId)];
  }

  /**
   * The first of the mission's repositories whose checkout can read the link,
   * if any, and which one it was. Each repository is tried even when an
   * earlier one failed: a checkout with a broken remote says nothing about the
   * next one. Reading is not where the head goes: `#localHead` decides that.
   */
  async #resolve(mission: Mission, url: string): Promise<{ snapshot: PullRequestSnapshot | null; failure: unknown; repository: Repository | null }> {
    let failure: unknown = null;
    for (const repo of this.#repositoriesFor(mission)) {
      try {
        const snapshot = await this.deps.snapshots.read(url, repo.path);
        if (snapshot !== null) return { snapshot, failure: null, repository: repo };
      } catch (e) {
        failure ??= e;
      }
    }
    return { snapshot: null, failure, repository: null };
  }

  /**
   * Makes the pull request's head a local branch, `tandemise/pr-<n>`, in the
   * repository it belongs to, and returns it once it points at the head gh
   * reported. The head branch itself is never assumed to be local: the pull
   * request may come from a fork, a web edit or another machine.
   *
   * A repository that already has the head commit (the person fetched or
   * pushed it, as the refusal asks) gets the branch without a fetch; a commit
   * id names exactly one commit, so this is safe in any of the repositories.
   * Otherwise GitHub's `pull/<n>/head` is fetched, but only through a remote
   * whose configured URL is the pull request's repository, the mission's own
   * repository first: another checkout's `origin` has its own pull request
   * with that number. `into` names where it should have landed, for the
   * refusal: the repository whose remote matched, or the pull request's own.
   */
  async #localHead(mission: Mission, pr: PullRequestSnapshot): Promise<{ branch: string | null; repository: Repository | null; into: string }> {
    const exec = this.deps.exec;
    const none = { branch: null, repository: null, into: pr.repo };
    if (exec === undefined || exec === null) return none;
    const branch = pullRequestBranch(pr.number);
    const ref = `refs/heads/${branch}`;
    const repositories = this.#repositoriesFor(mission);
    const runner = (cwd: string, env: Readonly<Record<string, string>> = {}): GitRun => (args) => exec.run({
      command: 'git', args, cwd, timeoutMs: FETCH_TIMEOUT_MS,
      // A remote that asks for a password has no one to ask here; it fails instead of hanging.
      env: { GIT_TERMINAL_PROMPT: '0', ...env },
    });
    try {
      for (const repository of repositories) {
        const git = runner(repository.path);
        if ((await git(['cat-file', '-e', `${pr.headRefOid}^{commit}`])).exitCode !== 0) continue;
        if ((await git(['update-ref', ref, pr.headRefOid])).exitCode === 0) return { branch, repository, into: repository.name };
      }
      let into = pr.repo;
      for (const repository of repositories) {
        const git = runner(repository.path, this.deps.credentialEnv?.() ?? {});
        const remote = await githubRemote(git, pr.repo);
        if (remote === null) continue;
        into = repository.name;
        // Forced, so handing back a pull request again after it moved updates the branch.
        const fetched = await git(['fetch', '--no-tags', remote, `+refs/pull/${pr.number}/head:${ref}`]);
        if (fetched.exitCode !== 0) continue;
        const head = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
        if (head.exitCode === 0 && head.stdout.trim() === pr.headRefOid) return { branch, repository, into };
        // It landed on another commit (the pull request moved since gh read
        // it): nothing may be left pointing at a head nobody handed back.
        await git(['update-ref', '-d', ref]);
      }
      return { ...none, into };
    } catch {
      // A runner that could not start git at all is the same failure as a fetch that did not land.
      return none;
    }
  }

  async adoptPullRequestHead(input: {
    repositoryPath: string; commit: string; worktrees: readonly { readonly directory: string; readonly branch: string }[];
  }): Promise<readonly string[]> {
    const exec = this.deps.exec;
    if (exec === undefined || exec === null) return input.worktrees.map((w) => `No git runner here to move ${w.branch}.`);
    const git = (args: readonly string[]) => exec.run({
      command: 'git', args, cwd: input.repositoryPath, timeoutMs: FETCH_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' },
    });
    const problems: string[] = [];
    for (const worktree of input.worktrees) {
      try {
        // Only a worktree of this repository: a step's worktree elsewhere shares
        // no branches with it. Compared through realpath, since git may record
        // a path reached through a link (macOS's /var) either way.
        await git(['worktree', 'prune']);
        const listed = await git(['worktree', 'list', '--porcelain']);
        const wanted = await realpathOrNull(worktree.directory);
        const paths = listed.stdout.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
        const registered = wanted !== null && (await Promise.all(paths.map(realpathOrNull))).includes(wanted);
        if (registered) {
          const removed = await git(['worktree', 'remove', '--force', worktree.directory]);
          if (removed.exitCode !== 0) { problems.push(`Could not remove the worktree at ${worktree.directory}.`); continue; }
        }
        const moved = await git(['branch', '-f', worktree.branch, input.commit]);
        if (moved.exitCode !== 0) problems.push(`Could not point ${worktree.branch} at ${input.commit}.`);
      } catch {
        problems.push(`Could not move ${worktree.branch}.`);
      }
    }
    return problems;
  }
}

/**
 * The remote whose configured URL is the pull request's repository on
 * GitHub, or null when none is. Read from the configured URLs rather than
 * `git remote -v`, which shows them after any `insteadOf` rewrite. Never a
 * guess such as `origin`: a remote for another repository has its own pull
 * request with the same number.
 */
async function githubRemote(git: GitRun, repo: string): Promise<string | null> {
  const listed = await git(['config', '--get-regexp', '^remote\\..*\\.url$']);
  if (listed.exitCode !== 0) return null;
  const wanted = repo.toLowerCase();
  for (const line of listed.stdout.split('\n')) {
    const entry = /^remote\.(.+)\.url\s+(\S+)$/.exec(line.trim());
    if (entry === null) continue;
    const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(entry[2]!);
    if (match !== null && match[1]!.toLowerCase() === wanted) return entry[1]!;
  }
  return null;
}

/**
 * Content in a Markdown code block whose fence is longer than any run of
 * backticks inside it (or in the text around it, `near`), so a diff that itself contains a fence (a README's
 * example, a changed Markdown file) cannot close the block early.
 */
export function fenced(info: string, content: string, ...near: readonly string[]): string {
  const longest = Math.max(0, ...[content, ...near].flatMap((text) => [...text.matchAll(/`+/g)].map((m) => m[0].length)));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${content}${content.endsWith('\n') ? '' : '\n'}${fence}`;
}

/** Sized from the encoded length first, so an oversized upload is refused without decoding it. */
function decode(dataBase64: string): Uint8Array {
  if (decodedSize(dataBase64) > CONTRIBUTION_MAX_BYTES) throw new ContributionError('too_large', 'That file is larger than 24 MB.');
  const bytes = Buffer.from(dataBase64, 'base64');
  if (bytes.byteLength === 0) throw new ContributionError('empty', 'That file is empty.');
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function fitTitle(text: string): string {
  return text.length <= TITLE_MAX ? text : `${text.slice(0, TITLE_MAX - 1)}…`;
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    // A path that does not exist names nothing to open, inside a root or not.
    return null;
  }
}
