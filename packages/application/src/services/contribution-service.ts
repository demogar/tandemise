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
}

/** What a contribution becomes on disk before it is pinned. */
interface Snapshot {
  readonly title: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly body: string | Uint8Array;
  readonly refs: (contentRef: string) => readonly ExternalRef[];
  readonly resolved: PullRequestSnapshot | null;
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
    return { evidence, filename: snapshot.filename, mediaType: snapshot.mediaType, resolved: snapshot.resolved };
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
      const branch = await this.#fetchHead(repository.path, pr);
      if (branch === null && requireBranch) {
        throw new ContributionError(
          'unfetchable_pull_request',
          `Couldn't fetch that pull request into ${repository.name}. Fetch or push its branch, then hand it back again.`,
        );
      }
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
    };
  }

  /**
   * The first of the mission's repositories whose checkout can read the link,
   * if any, and which one it was. Each repository is tried even when an
   * earlier one failed: a checkout with a broken remote says nothing about the
   * next one.
   */
  async #resolve(mission: Mission, url: string): Promise<{ snapshot: PullRequestSnapshot | null; failure: unknown; repository: Repository | null }> {
    let failure: unknown = null;
    for (const repo of this.deps.repositories.listByWorkspace(mission.workspaceId)) {
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
   * Fetches the pull request's head into `tandemise/pr-<n>` in the checkout
   * that read it, and returns that branch once it points at the head gh
   * reported. The head branch itself is never assumed to be local: the pull
   * request may come from a fork, a web edit or another machine, and GitHub's
   * `pull/<n>/head` ref is the one name every one of those shares. Null when
   * the fetch fails or lands on another commit, which the caller decides about.
   */
  async #fetchHead(cwd: string, pr: PullRequestSnapshot): Promise<string | null> {
    const exec = this.deps.exec;
    if (exec === undefined || exec === null) return null;
    const branch = pullRequestBranch(pr.number);
    const git = (args: readonly string[]) => exec.run({
      command: 'git', args, cwd, timeoutMs: FETCH_TIMEOUT_MS,
      // A remote that asks for a password has no one to ask here; it fails instead of hanging.
      env: { GIT_TERMINAL_PROMPT: '0' },
    });
    try {
      const remote = await this.#githubRemote(git, pr.repo);
      // Forced, so handing back a pull request again after it moved updates the branch.
      const fetched = await git(['fetch', '--no-tags', remote, `+refs/pull/${pr.number}/head:refs/heads/${branch}`]);
      if (fetched.exitCode !== 0) return null;
      const head = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
      return head.exitCode === 0 && head.stdout.trim() === pr.headRefOid ? branch : null;
    } catch {
      // A runner that could not start git at all is the same failure as a fetch that did not land.
      return null;
    }
  }

  /**
   * The remote that points at the pull request's repository on GitHub, or
   * `origin` when none names it (a mirror, or a checkout whose remote is a
   * local path). The repository is the one gh read the pull request from.
   */
  async #githubRemote(git: (args: readonly string[]) => Promise<{ exitCode: number; stdout: string }>, repo: string): Promise<string> {
    const listed = await git(['remote', '-v']);
    if (listed.exitCode !== 0) return 'origin';
    const wanted = repo.toLowerCase();
    for (const line of listed.stdout.split('\n')) {
      const [name, remoteUrl] = line.trim().split(/\s+/);
      if (name === undefined || remoteUrl === undefined) continue;
      const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(remoteUrl);
      if (match !== null && match[1]!.toLowerCase() === wanted) return name;
    }
    return 'origin';
  }
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
