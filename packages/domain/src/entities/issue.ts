import type { IssueLinkId, RepositoryId, Timestamp, WorkspaceId } from '@tandemise/shared';
import { CRITERION_STATEMENT_MAX, type TracedResult } from './criteria.js';
import type { MissionStatus } from './mission.js';

/**
 * GitHub issues in and out (P14 spec §1).
 *
 * Everything here is pure: parsing an issue's "Done when" list, the words a
 * mission and a comment are made of, and the decision of what an issue should
 * say given the mission's current state. The service gathers inputs (rows, the
 * P5 trace, the P9 verdict) and applies the answers through `gh`.
 *
 * Issue text is untrusted input. It only ever flows into a mission's title,
 * goal and criteria, and back out into comments (escaped). Nothing here reads
 * it for anything else, so an issue cannot change a setting, a label or which
 * issues are read.
 */

export const ISSUE_POLL_MINUTES = [5, 10, 15, 30, 60] as const;
export const DEFAULT_ISSUE_POLL_MINUTES = 10;
export const DEFAULT_ISSUE_LABEL = 'tandemise';
/** The newest open labelled issues read per check; the guide says so. */
export const MAX_ISSUES_PER_CHECK = 100;
export const MAX_ISSUE_CRITERIA = 20;
export const MAX_ISSUE_LABEL = 50;
/** `mission_criteria.decided_by` for lines parsed from an issue, so an edit replaces only those. */
export const ISSUE_CRITERIA_AUTHOR = 'github-issue';
/** A mission goal's limit (the create request's). */
const MAX_GOAL = 8000;
const MAX_TITLE = 200;

export const ISSUE_COMMENT_KINDS = ['queued', 'completed', 'blocked'] as const;
export type IssueCommentKind = (typeof ISSUE_COMMENT_KINDS)[number];

export const ISSUE_LINK_STATES = ['open', 'closed', 'unlabelled'] as const;
export type IssueLinkState = (typeof ISSUE_LINK_STATES)[number];

/** `pending` between writing the link and creating its mission; a restart finishes it. */
export type IssueLinkStatus = 'pending' | 'linked';

/** A repository's issue settings (one row per opted-in repository). */
export interface IssueSyncSettings {
  readonly repositoryId: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly enabled: boolean;
  /** `owner/name`, or `host/owner/name` for GitHub Enterprise; null until known. */
  readonly githubRepo: string | null;
  readonly label: string;
  readonly pollMinutes: number;
  readonly closeOnComplete: boolean;
  readonly postComments: boolean;
  /** The workflow each mission from an issue uses; null = the project's default. */
  readonly workflowPreset: string | null;
  /** The member who switched it on: missions from issues are created as them. */
  readonly enabledBy: string | null;
  readonly lastCheckedAt: Timestamp | null;
  readonly lastError: string | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export type IssueSyncPatch = Partial<Omit<IssueSyncSettings, 'repositoryId' | 'workspaceId' | 'createdAt' | 'updatedAt'>>;

/** One GitHub issue Tandemise has read, and the mission it became. */
export interface IssueLink {
  readonly id: IssueLinkId;
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: RepositoryId;
  readonly githubRepo: string;
  readonly number: number;
  readonly url: string;
  /** The title and body as last read: an edit is a difference from these. */
  readonly title: string;
  readonly body: string;
  readonly author: string | null;
  readonly upstreamUpdatedAt: string | null;
  readonly state: IssueLinkState;
  readonly status: IssueLinkStatus;
  /** Criteria parsed from the body when it was last read. */
  readonly criteriaCount: number;
  /** The mission's current stall was already reported (at most one comment per stall). */
  readonly stallOpen: boolean;
  readonly closedByUsAt: Timestamp | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export type IssueLinkDraft = Omit<IssueLink, 'id' | 'createdAt' | 'updatedAt' | 'stallOpen' | 'closedByUsAt' | 'status'>;
export type IssueLinkPatch = Partial<Omit<IssueLink, 'id' | 'workspaceId' | 'repositoryId' | 'number' | 'createdAt' | 'updatedAt'>>;

/** A comment Tandemise wrote on an issue: its GitHub id and the body last written. */
export interface IssueComment {
  readonly linkId: IssueLinkId;
  readonly kind: IssueCommentKind;
  readonly commentId: string;
  readonly body: string;
  readonly postedAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** An issue as `gh` returns it, normalised. */
export interface UpstreamIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly updatedAt: string;
  readonly labels: readonly string[];
  readonly author: string | null;
  readonly state: 'OPEN' | 'CLOSED';
}

export interface UpstreamComment {
  readonly id: string;
  readonly author: string | null;
  readonly body: string;
}

/**
 * GitHub, as far as issue sync needs it. Implemented over the `gh` CLI (its
 * existing sign-in is the only credential); `repo` is `owner/name` or
 * `host/owner/name`, and `cwd` is the repository's checkout.
 */
export interface IssueTrackerPort {
  listOpen(query: { readonly repo: string; readonly label: string; readonly limit: number; readonly cwd?: string }): Promise<readonly UpstreamIssue[]>;
  view(query: { readonly repo: string; readonly number: number; readonly cwd?: string }): Promise<UpstreamIssue>;
  /** The signed-in user's login: only their comments are adopted by marker. */
  viewer(query: { readonly repo: string; readonly cwd?: string }): Promise<string>;
  comments(query: { readonly repo: string; readonly number: number; readonly cwd?: string }): Promise<readonly UpstreamComment[]>;
  /** Answers with the new comment's id. */
  postComment(query: { readonly repo: string; readonly number: number; readonly body: string; readonly cwd?: string }): Promise<string>;
  updateComment(query: { readonly repo: string; readonly commentId: string; readonly body: string; readonly cwd?: string }): Promise<void>;
  close(query: { readonly repo: string; readonly number: number; readonly cwd?: string }): Promise<void>;
}

// ------------------------------------------------------------------ settings

const SLUG = /^(?:[A-Za-z0-9.-]+\/)?[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** `owner/name` (github.com) or `host/owner/name`, from a git remote URL; null when it is not one. */
export function githubRepoFromRemote(remote: string | null): string | null {
  if (remote === null) return null;
  const url = remote.trim();
  const m = /^(?:https?:\/\/|ssh:\/\/|git:\/\/)?(?:[^@/]+@)?([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) return null;
  const [, host, owner, name] = m as unknown as [string, string, string, string];
  if (!/github/i.test(host)) return null;
  const slug = host.toLowerCase() === 'github.com' ? `${owner}/${name}` : `${host}/${owner}/${name}`;
  return SLUG.test(slug) ? slug : null;
}

export function githubRepoProblem(value: string): string | null {
  return SLUG.test(value.trim()) ? null : 'Write the GitHub repository as owner/name, for example acme/website.';
}

export function issueLabelProblem(label: string): string | null {
  const l = label.trim();
  if (l.length === 0) return 'Give the label issues must carry, for example tandemise.';
  if (l.length > MAX_ISSUE_LABEL) return `A label is at most ${MAX_ISSUE_LABEL} characters.`;
  if (/[,\n\r]/.test(l)) return 'Use one label, without commas.';
  return null;
}

export function issuePollProblem(minutes: number): string | null {
  return (ISSUE_POLL_MINUTES as readonly number[]).includes(minutes)
    ? null
    : `Check every ${ISSUE_POLL_MINUTES.join(', ')} minutes.`;
}

/** `--repo` takes the slug as is; `gh api` takes `--hostname` for a host that is not github.com. */
export function splitGithubRepo(slug: string): { readonly host: string | null; readonly path: string } {
  const parts = slug.split('/');
  return parts.length === 3 ? { host: parts[0] ?? null, path: `${parts[1]}/${parts[2]}` } : { host: null, path: slug };
}

// ------------------------------------------------------------------ parsing

const SECTION_NAMES = /^(done when|acceptance criteria)$/i;
const FENCE = /^\s*(```|~~~)/;
const MD_HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const BOLD_LINE = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$/;
const PLAIN_HEAD = /^\s*([A-Za-z ]+?)\s*:\s*$/;
const INLINE = /^\s*(?:\*\*|__)?(done when|acceptance criteria)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(\S.*)$/i;
const CHECK_ITEM = /^\s*[-*+]\s+\[[ xX]\]\s+(.*)$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

function headingName(line: string): string | null {
  const heading = MD_HEADING.exec(line);
  if (heading) return clean(heading[1] ?? '').replace(/[:*_]+$/g, '').replace(/^[*_]+/, '').trim();
  const bold = BOLD_LINE.exec(line);
  if (bold) return clean(bold[1] ?? '').replace(/:$/, '').trim();
  return null;
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The "Done when" lines an issue states, deterministically (P14 spec §1).
 *
 * Only a section headed "Done when" or "Acceptance criteria" counts - a
 * checklist elsewhere is a to-do list, not acceptance. Inside it, checklist
 * items win over list items, which win over paragraphs. A ticked box counts
 * like an empty one: ticking it on GitHub verifies nothing.
 */
export function parseIssueCriteria(body: string): readonly string[] {
  const found: string[] = [];
  let section: string[] | null = null;
  const sections: string[][] = [];
  let fenced = false;
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const name = headingName(line);
    if (name !== null) {
      section = SECTION_NAMES.test(name) ? [] : null;
      if (section !== null) sections.push(section);
      continue;
    }
    const inline = INLINE.exec(line);
    if (inline) {
      found.push(inline[2] ?? '');
      section = null;
      continue;
    }
    const plain = PLAIN_HEAD.exec(line);
    if (plain && SECTION_NAMES.test(clean(plain[1] ?? ''))) {
      section = [];
      sections.push(section);
      continue;
    }
    if (RULE.test(line)) { section = null; continue; }
    section?.push(line);
  }
  for (const lines of sections) found.push(...sectionCriteria(lines));
  const out: string[] = [];
  for (const raw of found) {
    const text = clean(raw);
    const statement = text.length <= CRITERION_STATEMENT_MAX ? text : `${text.slice(0, CRITERION_STATEMENT_MAX - 1)}…`;
    if (statement.length > 0 && !out.includes(statement)) out.push(statement);
    if (out.length === MAX_ISSUE_CRITERIA) break;
  }
  return out;
}

function sectionCriteria(lines: readonly string[]): readonly string[] {
  const checks = lines.flatMap((l) => { const m = CHECK_ITEM.exec(l); return m ? [m[1] ?? ''] : []; });
  if (checks.length > 0) return checks;
  const items = lines.flatMap((l) => { const m = LIST_ITEM.exec(l); return m ? [m[1] ?? ''] : []; });
  if (items.length > 0) return items;
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of [...lines, '']) {
    if (line.trim() === '') {
      if (current.length > 0) paragraphs.push(current.join(' '));
      current = [];
    } else {
      current.push(line.trim());
    }
  }
  return paragraphs;
}

// ------------------------------------------------------------------ the mission

export function issueMissionTitle(issue: Pick<UpstreamIssue, 'title' | 'number'>): string {
  const title = clean(issue.title) || `Issue #${issue.number}`;
  return title.length <= MAX_TITLE ? title : `${title.slice(0, MAX_TITLE - 1)}…`;
}

/**
 * The mission's goal: the issue as written, attributed to its author. The
 * planner and every agent read it as the person's request - they chose to
 * label it - and nothing reads it as instructions to Tandemise itself.
 */
export function issueGoal(repo: string, issue: Pick<UpstreamIssue, 'number' | 'title' | 'body' | 'url' | 'author'>): string {
  const who = issue.author === null ? 'an unknown author' : `@${issue.author}`;
  const head = `GitHub issue #${issue.number} in ${repo}, opened by ${who}: ${issue.url}\n\nThe request as the issue's author wrote it:\n\n${clean(issue.title)}`;
  const body = issue.body.replace(/\r\n?/g, '\n').trim();
  if (body.length === 0) return head;
  const cut = '\n\n… (cut here; read the rest on GitHub)';
  const room = MAX_GOAL - head.length - 2;
  return body.length <= room ? `${head}\n\n${body}` : `${head}\n\n${body.slice(0, Math.max(0, room - cut.length))}${cut}`;
}

// ------------------------------------------------------------------ comments

export function issueMarker(kind: IssueCommentKind): string {
  return `<!-- tandemise:${kind} -->`;
}

export function hasIssueMarker(body: string, kind: IssueCommentKind): boolean {
  return body.includes(issueMarker(kind));
}

/**
 * Text from an issue (or an agent) put back into a GitHub comment: table
 * pipes and backticks escaped, and @mentions broken with a zero-width space,
 * so echoing a criterion never pings anyone.
 */
export function escapeForComment(text: string): string {
  return clean(text)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/<!--/g, '&lt;!--')
    .replace(/@(?=[A-Za-z0-9])/g, '@​');
}

export function resultWord(result: TracedResult): string {
  switch (result) {
    case 'PASS': return 'Verified';
    case 'FAIL': return 'Failed';
    case 'SKIP': return 'Skipped';
    default: return 'Not verified';
  }
}

const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export interface CommentCriterion {
  readonly key: string;
  readonly statement: string;
}

export function queuedCommentBody(criteria: readonly CommentCriterion[]): string {
  return [
    issueMarker('queued'),
    `Queued in Tandemise — ${plural(criteria.length, 'criterion', 'criteria')}.`,
    '',
    '| Key | Done when |',
    '|---|---|',
    ...criteria.map((c) => `| ${c.key} | ${escapeForComment(c.statement)} |`),
    '',
    'Tandemise plans this when it reaches the front of the backlog, and reports back here when the work is done.',
  ].join('\n');
}

export interface CompletedCriterion extends CommentCriterion {
  readonly result: TracedResult;
}

export type CloseIntent = 'closing' | 'left_open' | 'off';

export function completedCommentBody(input: {
  readonly rows: readonly CompletedCriterion[];
  readonly links: readonly { readonly label: string; readonly url: string }[];
  readonly close: CloseIntent;
}): string {
  const verified = input.rows.filter((r) => r.result === 'PASS').length;
  const notVerified = input.rows.length - verified;
  return [
    issueMarker('completed'),
    `Done in Tandemise — ${verified} of ${plural(input.rows.length, 'criterion', 'criteria')} verified.`,
    '',
    '| Key | Criterion | Result |',
    '|---|---|---|',
    ...input.rows.map((r) => `| ${r.key} | ${escapeForComment(r.statement)} | ${resultWord(r.result)} |`),
    ...(input.links.length > 0 ? ['', ...input.links.map((l) => `- ${escapeForComment(l.label)}: ${l.url}`)] : []),
    ...(input.close === 'closing' ? ['', 'Closing this issue: every criterion was verified.'] : []),
    ...(input.close === 'left_open' ? ['', `Left open: ${plural(notVerified, 'criterion was', 'criteria were')} not verified.`] : []),
  ].join('\n');
}

export function blockedCommentBody(reason: string, action: string | null): string {
  return [
    issueMarker('blocked'),
    `Tandemise is stuck on this: ${escapeForComment(reason)}${action === null ? '' : ` Next step in Tandemise: ${escapeForComment(action)}.`}`,
    '',
    'The person running Tandemise has been told; this comment is updated if it gets stuck again.',
  ].join('\n');
}

/** Every row of the P5 trace verified, and at least one: the only case an issue is closed. */
export function allCriteriaVerified(rows: readonly { readonly result: TracedResult }[]): boolean {
  return rows.length > 0 && rows.every((r) => r.result === 'PASS');
}

// ------------------------------------------------------------------ write-back

export interface WriteBackInput {
  readonly settings: Pick<IssueSyncSettings, 'postComments' | 'closeOnComplete'>;
  readonly link: Pick<IssueLink, 'state' | 'stallOpen' | 'closedByUsAt'>;
  readonly mission: { readonly status: MissionStatus; readonly queued: boolean };
  /** The mission's accepted Done-when lines (user criteria), for the queued comment. */
  readonly criteria: readonly CommentCriterion[];
  /** The P5 trace, for the completed comment. */
  readonly trace: readonly CompletedCriterion[];
  readonly links: readonly { readonly label: string; readonly url: string }[];
  /** P9's verdict when the mission is stalled. */
  readonly stalled: { readonly reason: string; readonly action: string | null } | null;
  /** Bodies already on the issue, by kind. */
  readonly posted: Partial<Record<IssueCommentKind, string>>;
}

export interface WriteBackPlan {
  /** Comments to post or update (the body differs from what the issue says). */
  readonly comments: readonly { readonly kind: IssueCommentKind; readonly body: string }[];
  readonly close: boolean;
  /** The stall flag after this pass. */
  readonly stallOpen: boolean;
}

/**
 * What an issue should say now, compared with what it says (P14 spec §1).
 * Derived from state, never from events, so running it twice - or after a
 * restart - asks for nothing the second time.
 */
export function decideWriteBack(input: WriteBackInput): WriteBackPlan {
  const comments: { kind: IssueCommentKind; body: string }[] = [];
  const want = (kind: IssueCommentKind, body: string): void => {
    if (input.posted[kind] !== body) comments.push({ kind, body });
  };
  const complete = input.mission.status === 'COMPLETE';
  const verified = allCriteriaVerified(input.trace);
  const close = input.settings.closeOnComplete && complete && verified && input.link.closedByUsAt === null && input.link.state === 'open';
  if (input.settings.postComments) {
    if (input.mission.status === 'DRAFT' && input.mission.queued && input.criteria.length > 0) {
      want('queued', queuedCommentBody(input.criteria));
    }
    if (input.stalled !== null && !input.link.stallOpen) {
      want('blocked', blockedCommentBody(input.stalled.reason, input.stalled.action));
    }
    if (complete) {
      const intent: CloseIntent = !input.settings.closeOnComplete ? 'off' : verified ? 'closing' : 'left_open';
      want('completed', completedCommentBody({ rows: input.trace, links: input.links, close: intent }));
    }
  }
  return { comments, close, stallOpen: input.stalled !== null };
}

// ------------------------------------------------------------------ words

export function issueCheckLabel(input: {
  readonly enabled: boolean;
  readonly checking: boolean;
  readonly lastCheckedMs: number | null;
  readonly nowMs: number;
  readonly linked: number;
}): string {
  if (!input.enabled) return 'Off';
  if (input.checking) return 'Checking…';
  const linked = `${input.linked} linked`;
  if (input.lastCheckedMs === null) return `Not checked yet · ${linked}`;
  return `Last checked ${agoLabel(input.nowMs - input.lastCheckedMs)} · ${linked}`;
}

function agoLabel(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return plural(Math.floor(h / 24), 'day') + ' ago';
}

export function issueCreatedNote(issue: Pick<UpstreamIssue, 'number' | 'author' | 'url'>, criteria: number): string {
  const by = issue.author === null ? '' : ` by @${issue.author}`;
  const ready = criteria > 0
    ? `Its Done-when list gave ${plural(criteria, 'criterion', 'criteria')}, so it is queued.`
    : 'It has no Done-when list, so it waits for refinement.';
  return `Created from GitHub issue #${issue.number}${by}: ${issue.url}. ${ready}`;
}

export function issueEditedNote(number: number, planned: boolean): string {
  return planned
    ? `Issue #${number} was edited upstream after planning started; this mission keeps its plan.`
    : `Issue #${number} was edited upstream; the goal and Done-when lines were updated.`;
}

export function issueClosedNote(number: number, draft: boolean, wasQueued: boolean): string {
  if (!draft) return `Issue #${number} was closed upstream; this mission carries on. Cancel it if the work is no longer wanted.`;
  return wasQueued
    ? `Issue #${number} was closed upstream, so this draft was taken off the queue.`
    : `Issue #${number} was closed upstream; this draft stays off the queue.`;
}

export function issueReopenedNote(number: number): string {
  return `Issue #${number} was reopened upstream.`;
}
