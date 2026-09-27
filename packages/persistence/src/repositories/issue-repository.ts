import { TandemiseError, asId, ids, type Clock, type IssueLinkId, type RepositoryId, type WorkspaceId } from '@tandemise/shared';
import type {
  IssueComment, IssueCommentKind, IssueLink, IssueLinkDraft, IssueLinkPatch, IssueLinkState, IssueLinkStatus,
  IssueRepositoryPort, IssueSyncPatch, IssueSyncSettings,
} from '@tandemise/domain';
import { DEFAULT_ISSUE_LABEL, DEFAULT_ISSUE_POLL_MINUTES } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { applyPatch } from '../patch.js';

interface SyncRow {
  repository_id: string;
  workspace_id: string;
  enabled: number;
  github_repo: string | null;
  label: string;
  poll_minutes: number;
  close_on_complete: number;
  post_comments: number;
  workflow_preset: string | null;
  enabled_by: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface LinkRow {
  id: string;
  workspace_id: string;
  repository_id: string;
  github_repo: string;
  issue_number: number;
  url: string;
  title: string;
  body: string;
  author: string | null;
  upstream_updated_at: string | null;
  state: string;
  status: string;
  criteria_count: number;
  stall_open: number;
  closed_by_us_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CommentRow {
  link_id: string;
  kind: string;
  comment_id: string;
  body: string;
  posted_at: string;
  updated_at: string;
}

const SYNC_COLUMNS = `repository_id, workspace_id, enabled, github_repo, label, poll_minutes, close_on_complete, post_comments,
  workflow_preset, enabled_by, last_checked_at, last_error, created_at, updated_at`;
const LINK_COLUMNS = `id, workspace_id, repository_id, github_repo, issue_number, url, title, body, author, upstream_updated_at,
  state, status, criteria_count, stall_open, closed_by_us_at, created_at, updated_at`;

function syncFromRow(r: SyncRow): IssueSyncSettings {
  return {
    repositoryId: asId<'RepositoryId'>(r.repository_id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    enabled: r.enabled === 1,
    githubRepo: r.github_repo,
    label: r.label,
    pollMinutes: r.poll_minutes,
    closeOnComplete: r.close_on_complete === 1,
    postComments: r.post_comments === 1,
    workflowPreset: r.workflow_preset,
    enabledBy: r.enabled_by,
    lastCheckedAt: r.last_checked_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function syncToRow(s: IssueSyncSettings): SyncRow {
  return {
    repository_id: s.repositoryId,
    workspace_id: s.workspaceId,
    enabled: s.enabled ? 1 : 0,
    github_repo: s.githubRepo,
    label: s.label,
    poll_minutes: s.pollMinutes,
    close_on_complete: s.closeOnComplete ? 1 : 0,
    post_comments: s.postComments ? 1 : 0,
    workflow_preset: s.workflowPreset,
    enabled_by: s.enabledBy,
    last_checked_at: s.lastCheckedAt,
    last_error: s.lastError,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

function linkFromRow(r: LinkRow): IssueLink {
  return {
    id: asId<'IssueLinkId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    repositoryId: asId<'RepositoryId'>(r.repository_id),
    githubRepo: r.github_repo,
    number: r.issue_number,
    url: r.url,
    title: r.title,
    body: r.body,
    author: r.author,
    upstreamUpdatedAt: r.upstream_updated_at,
    state: r.state as IssueLinkState,
    status: r.status as IssueLinkStatus,
    criteriaCount: r.criteria_count,
    stallOpen: r.stall_open === 1,
    closedByUsAt: r.closed_by_us_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function linkToRow(l: IssueLink): LinkRow {
  return {
    id: l.id,
    workspace_id: l.workspaceId,
    repository_id: l.repositoryId,
    github_repo: l.githubRepo,
    issue_number: l.number,
    url: l.url,
    title: l.title,
    body: l.body,
    author: l.author,
    upstream_updated_at: l.upstreamUpdatedAt,
    state: l.state,
    status: l.status,
    criteria_count: l.criteriaCount,
    stall_open: l.stallOpen ? 1 : 0,
    closed_by_us_at: l.closedByUsAt,
    created_at: l.createdAt,
    updated_at: l.updatedAt,
  };
}

function commentFromRow(r: CommentRow): IssueComment {
  return {
    linkId: asId<'IssueLinkId'>(r.link_id),
    kind: r.kind as IssueCommentKind,
    commentId: r.comment_id,
    body: r.body,
    postedAt: r.posted_at,
    updatedAt: r.updated_at,
  };
}

/** GitHub issue sync (P14): settings, links and the comments written on each. */
export class SqliteIssueRepository implements IssueRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #clock: Clock;
  readonly #selectSync;
  readonly #selectSyncByWorkspace;
  readonly #selectEnabled;
  readonly #upsertSync;
  readonly #selectLink;
  readonly #findLink;
  readonly #selectLinks;
  readonly #insertLink;
  readonly #updateLink;
  readonly #selectComments;
  readonly #upsertComment;
  readonly #deleteComment;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    this.#selectSync = db.handle.prepare<{ id: string }, SyncRow>(`SELECT ${SYNC_COLUMNS} FROM issue_sync WHERE repository_id = :id`);
    this.#selectSyncByWorkspace = db.handle.prepare<{ ws: string }, SyncRow>(
      `SELECT ${SYNC_COLUMNS} FROM issue_sync WHERE workspace_id = :ws ORDER BY created_at, repository_id`,
    );
    this.#selectEnabled = db.handle.prepare<[], SyncRow>(
      `SELECT ${SYNC_COLUMNS} FROM issue_sync WHERE enabled = 1 ORDER BY created_at, repository_id`,
    );
    this.#upsertSync = db.handle.prepare<SyncRow>(
      `INSERT INTO issue_sync (${SYNC_COLUMNS}) VALUES (:repository_id, :workspace_id, :enabled, :github_repo, :label, :poll_minutes,
         :close_on_complete, :post_comments, :workflow_preset, :enabled_by, :last_checked_at, :last_error, :created_at, :updated_at)
       ON CONFLICT (repository_id) DO UPDATE SET enabled = excluded.enabled, github_repo = excluded.github_repo, label = excluded.label,
         poll_minutes = excluded.poll_minutes, close_on_complete = excluded.close_on_complete, post_comments = excluded.post_comments,
         workflow_preset = excluded.workflow_preset, enabled_by = excluded.enabled_by, last_checked_at = excluded.last_checked_at,
         last_error = excluded.last_error, updated_at = excluded.updated_at`,
    );
    this.#selectLink = db.handle.prepare<{ id: string }, LinkRow>(`SELECT ${LINK_COLUMNS} FROM issue_links WHERE id = :id`);
    this.#findLink = db.handle.prepare<{ repo: string; n: number }, LinkRow>(
      `SELECT ${LINK_COLUMNS} FROM issue_links WHERE repository_id = :repo AND issue_number = :n`,
    );
    this.#selectLinks = db.handle.prepare<{ ws: string | null; repo: string | null }, LinkRow>(
      `SELECT ${LINK_COLUMNS} FROM issue_links
       WHERE (:ws IS NULL OR workspace_id = :ws) AND (:repo IS NULL OR repository_id = :repo)
       ORDER BY repository_id, issue_number`,
    );
    this.#insertLink = db.handle.prepare<LinkRow>(
      `INSERT INTO issue_links (${LINK_COLUMNS}) VALUES (:id, :workspace_id, :repository_id, :github_repo, :issue_number, :url, :title,
         :body, :author, :upstream_updated_at, :state, :status, :criteria_count, :stall_open, :closed_by_us_at, :created_at, :updated_at)`,
    );
    this.#updateLink = db.handle.prepare<LinkRow>(
      `UPDATE issue_links SET github_repo = :github_repo, url = :url, title = :title, body = :body, author = :author,
         upstream_updated_at = :upstream_updated_at, state = :state, status = :status, criteria_count = :criteria_count,
         stall_open = :stall_open, closed_by_us_at = :closed_by_us_at, updated_at = :updated_at
       WHERE id = :id`,
    );
    this.#selectComments = db.handle.prepare<{ id: string }, CommentRow>(
      'SELECT link_id, kind, comment_id, body, posted_at, updated_at FROM issue_comments WHERE link_id = :id ORDER BY posted_at, kind',
    );
    this.#upsertComment = db.handle.prepare<CommentRow>(
      `INSERT INTO issue_comments (link_id, kind, comment_id, body, posted_at, updated_at)
       VALUES (:link_id, :kind, :comment_id, :body, :posted_at, :updated_at)
       ON CONFLICT (link_id, kind) DO UPDATE SET comment_id = excluded.comment_id, body = excluded.body, updated_at = excluded.updated_at`,
    );
    this.#deleteComment = db.handle.prepare<{ id: string; kind: string }>('DELETE FROM issue_comments WHERE link_id = :id AND kind = :kind');
  }

  settings(repositoryId: RepositoryId): IssueSyncSettings | undefined {
    const row = this.#selectSync.get({ id: repositoryId });
    return row === undefined ? undefined : syncFromRow(row);
  }

  saveSettings(repositoryId: RepositoryId, workspaceId: WorkspaceId, patch: IssueSyncPatch): IssueSyncSettings {
    const now = this.#clock.now();
    const current = this.settings(repositoryId) ?? {
      repositoryId, workspaceId, enabled: false, githubRepo: null, label: DEFAULT_ISSUE_LABEL, pollMinutes: DEFAULT_ISSUE_POLL_MINUTES,
      closeOnComplete: false, postComments: true, workflowPreset: null, enabledBy: null, lastCheckedAt: null, lastError: null,
      createdAt: now, updatedAt: now,
    };
    const next: IssueSyncSettings = { ...applyPatch(current, patch), updatedAt: now };
    this.#upsertSync.run(syncToRow(next));
    return next;
  }

  listSettings(workspaceId: WorkspaceId): readonly IssueSyncSettings[] {
    return this.#selectSyncByWorkspace.all({ ws: workspaceId }).map(syncFromRow);
  }

  listEnabled(): readonly IssueSyncSettings[] {
    return this.#selectEnabled.all().map(syncFromRow);
  }

  getLink(id: IssueLinkId): IssueLink | undefined {
    const row = this.#selectLink.get({ id });
    return row === undefined ? undefined : linkFromRow(row);
  }

  findLink(repositoryId: RepositoryId, number: number): IssueLink | undefined {
    const row = this.#findLink.get({ repo: repositoryId, n: number });
    return row === undefined ? undefined : linkFromRow(row);
  }

  listLinks(filter: { readonly workspaceId?: WorkspaceId; readonly repositoryId?: RepositoryId }): readonly IssueLink[] {
    return this.#selectLinks.all({ ws: filter.workspaceId ?? null, repo: filter.repositoryId ?? null }).map(linkFromRow);
  }

  createLink(draft: IssueLinkDraft): IssueLink {
    const now = this.#clock.now();
    const link: IssueLink = { ...draft, id: ids.issueLink(), status: 'pending', stallOpen: false, closedByUsAt: null, createdAt: now, updatedAt: now };
    this.#insertLink.run(linkToRow(link));
    return link;
  }

  updateLink(id: IssueLinkId, patch: IssueLinkPatch): IssueLink {
    return this.#db.transaction(() => {
      const current = this.getLink(id);
      if (current === undefined) throw TandemiseError.notFound('Issue link', id);
      const next: IssueLink = { ...applyPatch(current, patch), updatedAt: this.#clock.now() };
      this.#updateLink.run(linkToRow(next));
      return next;
    });
  }

  comments(linkId: IssueLinkId): readonly IssueComment[] {
    return this.#selectComments.all({ id: linkId }).map(commentFromRow);
  }

  saveComment(linkId: IssueLinkId, kind: IssueCommentKind, commentId: string, body: string): IssueComment {
    const now = this.#clock.now();
    this.#upsertComment.run({ link_id: linkId, kind, comment_id: commentId, body, posted_at: now, updated_at: now });
    const saved = this.comments(linkId).find((c) => c.kind === kind);
    if (saved === undefined) throw new TandemiseError('INTERNAL', `Issue comment ${kind} was not stored for ${linkId}`);
    return saved;
  }

  dropComment(linkId: IssueLinkId, kind: IssueCommentKind): void {
    this.#deleteComment.run({ id: linkId, kind });
  }
}
