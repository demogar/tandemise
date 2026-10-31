import type { Brand, Timestamp, TrackerItemId, WorkspaceId } from '@tandemise/shared';
import type { TrackerConfig } from './intake.js';
import { escapeForComment } from './issue.js';

/**
 * The project's primary tracker, as Tandemise sees it (spec §6).
 *
 * Plan Task 2 declares the item shapes here so the store can cache the board;
 * Task 4 adds `trackerRef()` and the pure helpers both adapters share. The
 * port itself is `PrimaryTracker` in `ports/intake.ts`.
 */

/**
 * A tracker item's normalised reference, `<tracker>:<key>` (`youtrack:GAR-12`,
 * `github:acme/web#42`), the relay's normalisation. Stored as plain text.
 */
export type TrackerRef = Brand<string, 'TrackerRef'>;

/** `trackerRef('youtrack', 'GAR-12')` is `youtrack:GAR-12`; `trackerRef('github', 'acme/web#42')` is `github:acme/web#42`. */
export function trackerRef(kind: 'youtrack' | 'github', key: string): TrackerRef {
  return `${kind}:${key}` as TrackerRef;
}

/**
 * One item as the tracker reports it (spec §6), plus `createdAt`, which the
 * board needs to keep the older of two duplicates (plan Task 8).
 */
export interface TrackerItem {
  readonly ref: TrackerRef;
  readonly key: string;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly state: string;
  readonly assignee: string | null;
  /** ISO 8601, the tracker's own. */
  readonly updatedAt: string;
  /** ISO 8601, the tracker's own. */
  readonly createdAt: string;
  readonly type?: string;
}

/** A cached board item: the tracker's item plus what Tandemise keeps about it. */
export interface TrackedItem extends TrackerItem {
  readonly id: TrackerItemId;
  readonly workspaceId: WorkspaceId;
  /**
   * The state Tandemise last wrote; null if it never wrote one. Write-back
   * moves the item only while it is still in this state, so a person's own
   * change always wins (spec §6.3, plan Review Focus 3).
   */
  readonly writtenState: string | null;
  readonly refreshedAt: Timestamp;
}

/** The two comments Tandemise keeps on an item, one each (spec §6, P14 rulings 7 and 8). */
export const TRACKER_COMMENT_MARKERS = ['tandemise:sources', 'tandemise:activity'] as const;
export type TrackerCommentMarker = (typeof TRACKER_COMMENT_MARKERS)[number];

/** The comment Tandemise wrote per `(item, marker)`, with the body last written. */
export interface TrackerCommentRow {
  readonly workspaceId: WorkspaceId;
  readonly itemRef: string;
  readonly marker: TrackerCommentMarker;
  readonly commentId: string;
  readonly body: string;
  readonly postedAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** The line a Tandemise comment starts with, so it is found again after a crash (P14 ruling 7). */
export function markerLine(marker: string): string {
  return `<!-- ${marker} -->`;
}

// ------------------------------------------------------------------ the Sources section (spec §5 step 3, §6.1)

const SOURCES_HEADING = '## Sources';
const URL_RE = /https?:\/\/\S+/g;
/** How many lines of a source's context the sources comment keeps. */
const MAX_CONTEXT_LINES = 6;

/**
 * The Sources section of a created item's description: one `- ` line per
 * source, each ending with its URL (`- Sentry · acme/web · 132 events, 41 users · <url>`).
 * The lines are already rendered (and escaped) by the caller.
 */
export function sourcesSection(lines: readonly string[]): string {
  return [SOURCES_HEADING, ...lines.map((l) => `- ${l}`)].join('\n');
}

/**
 * The source URLs a description or a sources comment lists, in order: the
 * last URL of every `- ` line under `## Sources`, up to the first line that is
 * neither an entry nor an entry's indented context. This is what exact-URL
 * dedupe matches (spec §5 step 3).
 */
export function parseSourcesSection(description: string): readonly string[] {
  return sourceBlocks(description).map((b) => b.url);
}

/** One source of an item, as `PrimaryTracker.link` receives it. */
export interface SourceEntry {
  readonly url: string;
  readonly title: string;
  /** A few lines: impact, reporter, the first lines of the description. Copied text, escaped on render. */
  readonly context: string;
}

/**
 * The body of the `tandemise:sources` comment (without its marker line, which
 * the adapter's `comment()` puts first): the Sources section with one entry per
 * URL and its context indented under it.
 */
export function sourcesCommentBody(entries: readonly SourceEntry[]): string {
  const blocks: { url: string; text: string }[] = [];
  for (const e of entries) upsertBlock(blocks, e);
  return renderBlocks(blocks);
}

/**
 * The sources comment with `source` added: a URL already listed has its entry
 * replaced in place (the latest context wins), a new one is appended (spec
 * §6.1: the comment is edited as sources are added, never re-posted).
 * `existing` is the comment's current text, marker line included, or null.
 */
export function sourcesCommentWith(existing: string | null, source: SourceEntry): string {
  const blocks = existing === null ? [] : sourceBlocks(existing).map((b) => ({ url: b.url, text: b.text }));
  upsertBlock(blocks, source);
  return renderBlocks(blocks);
}

function renderEntry(e: SourceEntry): string {
  const context = e.context.split(/\r?\n/).map((l) => escapeForComment(l)).filter((l) => l.length > 0).slice(0, MAX_CONTEXT_LINES);
  return [`- ${escapeForComment(e.title)} · ${e.url}`, ...context.map((l) => `  > ${l}`)].join('\n');
}

function upsertBlock(blocks: { url: string; text: string }[], e: SourceEntry): void {
  const text = renderEntry(e);
  const at = blocks.findIndex((b) => b.url === e.url);
  if (at >= 0) blocks[at] = { url: e.url, text };
  else blocks.push({ url: e.url, text });
}

function renderBlocks(blocks: readonly { text: string }[]): string {
  return [SOURCES_HEADING, ...blocks.map((b) => b.text)].join('\n');
}

function sourceBlocks(text: string): { url: string; text: string }[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() === SOURCES_HEADING);
  if (start < 0) return [];
  const blocks: { url: string; lines: string[] }[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('- ')) {
      const urls = line.match(URL_RE);
      if (urls === null) break;
      blocks.push({ url: urls[urls.length - 1]!, lines: [line] });
    } else if (line.startsWith('  ') && blocks.length > 0 && line.trim().length > 0) {
      blocks[blocks.length - 1]!.lines.push(line);
    } else {
      break;
    }
  }
  return blocks.map((b) => ({ url: b.url, text: b.lines.join('\n') }));
}

// ------------------------------------------------------------------ state mapping (spec §6.2)

const TRACKER_LABELS: Readonly<Record<string, string>> = { youtrack: 'YouTrack', 'github-issues': 'GitHub' };

/**
 * Why a project's state mapping cannot be used with its tracker, in the words
 * the project's settings show, or null when it can (spec §6.2). Every mapped
 * state must be one the tracker has (`describe().states`), and without an
 * `in_review` state a finished mission can only be marked done.
 */
export function stateMappingProblem(
  mapping: Pick<TrackerConfig, 'kind' | 'project' | 'repo' | 'states' | 'onComplete'>,
  described: { readonly states: readonly string[] },
): string | null {
  const s = mapping.states;
  const named = [...s.ready, s.in_progress, ...(s.in_review === undefined ? [] : [s.in_review]), ...s.done, ...s.wont_do];
  const missing = named.find((state) => !described.states.includes(state));
  if (missing !== undefined) {
    const tracker = TRACKER_LABELS[mapping.kind] ?? mapping.kind;
    const where = mapping.project ?? mapping.repo ?? 'this project';
    return `${tracker} has no state '${missing}' in ${where}. Its states are: ${described.states.join(', ')}.`;
  }
  if (s.in_review === undefined && mapping.onComplete === 'in_review') {
    return 'Without an in-review state, a finished mission can only mark the task done.';
  }
  return null;
}
