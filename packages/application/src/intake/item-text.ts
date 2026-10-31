import type { Impact, IntakeAttachment, IntakeSignal, IntakeSourceConfig, SourceEntry } from '@tandemise/domain';
import { escapeForComment, sourcesSection } from '@tandemise/domain';

/**
 * The text Tandemise writes into the primary tracker for a signal (spec §6.1,
 * plan Task 7).
 *
 * Signal text is untrusted (spec §1 "Text is data"): every line copied from a
 * signal is escaped with `escapeForComment`, so @mentions are broken and a
 * Tandemise marker cannot be forged, and a line that would start another
 * Sources section is defused, so a signal cannot add URLs to what exact-URL
 * dedupe matches (spec §5 step 3). The signal's URL is written as it is: the
 * contract accepts only https links, and dedupe needs it byte for byte.
 */

/** What `PrimaryTracker.create` receives for a new item. */
export interface ItemDraft {
  readonly title: string;
  readonly description: string;
  readonly type?: string;
  readonly fields?: Readonly<Record<string, string>>;
}

const SOURCES_HEADING = /^\s*#+\s*sources\s*$/i;
/** How many lines of the signal's description the sources comment quotes (spec §6.1 "first lines"). */
const CONTEXT_DESCRIPTION_LINES = 3;

/**
 * A new item: the signal's description, then the Sources section
 * (`- Sentry · acme/web · 132 events, 41 users · <url>`), then who recorded it.
 * Type and fields come from the source's `create` rule, never from the signal.
 * URL attachments are listed as links; inline ones are named (the tracker
 * gets the upload when it takes uploads).
 */
export function createDraft(
  signal: Pick<IntakeSignal, 'title' | 'description' | 'instance' | 'impact' | 'reporter' | 'url'>,
  source: Pick<IntakeSourceConfig, 'create'>,
  label: string,
  attachments: readonly Pick<IntakeAttachment, 'name' | 'url'>[] = [],
): ItemDraft {
  const parts: string[] = [];
  const description = escapeLines(signal.description);
  if (description.length > 0) parts.push(description);
  if (attachments.length > 0) {
    parts.push(['Attachments:', ...attachments.map((a) => `- ${escapeForComment(a.name)}${a.url === null ? '' : ` · ${a.url}`}`)].join('\n'));
  }
  const segments = [label, escapeForComment(signal.instance), impactWords(signal.impact), signal.url].filter((s) => s !== null && s !== '');
  parts.push(sourcesSection([segments.join(' · ')]));
  parts.push(`Recorded by Tandemise from ${label}, reported by ${reporterName(signal.reporter)}.`);
  return {
    title: escapeTitle(signal.title),
    description: parts.join('\n\n'),
    ...(source.create?.type === undefined ? {} : { type: source.create.type }),
    ...(source.create?.fields === undefined ? {} : { fields: source.create.fields }),
  };
}

/**
 * The entry a signal adds to an existing item's sources comment: its source and
 * instance as the title, and a few lines of context (its title, impact,
 * reporter and the first lines of its description). `sourcesCommentWith`
 * escapes both when it renders the comment.
 */
export function linkContext(signal: Pick<IntakeSignal, 'title' | 'description' | 'impact' | 'reporter'>): string {
  const lines = [signal.title];
  const impact = impactWords(signal.impact);
  if (impact !== null) lines.push(impact);
  if (signal.reporter !== null) lines.push(`Reported by ${reporterName(signal.reporter)}`);
  const first = signal.description.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  lines.push(...first.slice(0, CONTEXT_DESCRIPTION_LINES));
  return lines.join('\n');
}

/** The sources-comment entry for a signal (`PrimaryTracker.link`). */
export function sourceEntry(signal: Pick<IntakeSignal, 'title' | 'description' | 'impact' | 'reporter' | 'url' | 'instance'>, label: string): SourceEntry {
  return { url: signal.url, title: `${label} · ${signal.instance}`, context: linkContext(signal) };
}

/** `132 events, 41 users`; null when the signal carries no counts, so the segment is left out. */
export function impactWords(impact: Impact | null): string | null {
  if (impact === null) return null;
  const words: string[] = [];
  if (impact.events !== undefined) words.push(`${impact.events} ${impact.events === 1 ? 'event' : 'events'}`);
  if (impact.users !== undefined) words.push(`${impact.users} ${impact.users === 1 ? 'user' : 'users'}`);
  return words.length === 0 ? null : words.join(', ');
}

function reporterName(reporter: IntakeSignal['reporter']): string {
  const name = reporter?.name ?? reporter?.handle;
  return name === undefined || name.trim() === '' ? 'someone' : escapeForComment(name);
}

/** Line by line, so the description keeps its shape; a Sources heading is defused. */
function escapeLines(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (SOURCES_HEADING.test(line) ? `\\${line.trim()}` : escapeForComment(line)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A title is one line; its @mentions are broken like any copied text. */
function escapeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().replace(/@(?=[A-Za-z0-9])/g, '@​');
}
