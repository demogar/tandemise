import { HANDOFF_LINK_KINDS, type ArtifactHandoff } from '@tandemise/domain';
import { z } from 'zod';

/**
 * The limits of the handoff block, in characters or items (P1 spec §1).
 *
 * They are small on purpose: the handoff is read on a card in about twenty
 * seconds, so a headline that wraps or a fourth point is already a failure of
 * the format, not a matter of taste. Templates quote these same numbers.
 */
export const HANDOFF_LIMITS = {
  title: 60,
  headline: 90,
  point: 140,
  points: 3,
  needs: 140,
  changedWhat: 140,
  changed: 3,
  linkLabel: 40,
  links: 5,
  stop: 200,
} as const;

const text = (what: string, max: number) => z.string().trim()
  .min(1, `${what} must not be empty`)
  .max(max, `${what} must be at most ${max} characters`);

/**
 * An optional line written blank means "nothing", not a broken handoff. An
 * agent writes `needs: ""` for "nothing needed"; refusing it would fail the
 * harvest and spend an attempt on an empty string.
 */
const blankAsAbsent = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? null : value), schema);

const httpUrl = z.string().trim()
  .url('link url must be a full URL')
  // A link is opened from the desktop with one click, so only web links are
  // allowed; `file:` or `javascript:` would be a way to run something locally.
  .refine((url) => /^https?:\/\//i.test(url), 'link url must start with http:// or https://');

/**
 * The handoff schema. Input may omit every optional part; output is normalised
 * (`needs` and `feedback` null, lists empty, link kind `other`) so readers
 * never have to tell "absent" from "empty".
 */
export const handoffSchema: z.ZodType<ArtifactHandoff, z.ZodTypeDef, unknown> = z.object({
  headline: text('handoff.headline', HANDOFF_LIMITS.headline),
  points: z.array(text('a handoff point', HANDOFF_LIMITS.point))
    .max(HANDOFF_LIMITS.points, `handoff.points may have at most ${HANDOFF_LIMITS.points} items`)
    .default([]),
  needs: blankAsAbsent(text('handoff.needs', HANDOFF_LIMITS.needs).nullable().default(null)),
  changed: z.array(z.object({
    what: text('handoff.changed what', HANDOFF_LIMITS.changedWhat),
    feedback: blankAsAbsent(z.string().trim().min(1).nullable().default(null)),
  })).max(HANDOFF_LIMITS.changed, `handoff.changed may have at most ${HANDOFF_LIMITS.changed} items`).default([]),
  links: z.array(z.object({
    label: text('link label', HANDOFF_LIMITS.linkLabel),
    url: httpUrl.optional(),
    // A path into the repository or artifact root (spec A5), resolved by the
    // daemon rather than opened in a browser - so it makes sense only for a
    // workspace link, and only that kind may go without a url.
    path: z.string().trim().min(1).optional(),
    kind: z.enum(HANDOFF_LINK_KINDS).default('other'),
  }).superRefine((link, ctx) => {
    if (link.path !== undefined && link.kind !== 'workspace') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'only a workspace link may carry a path', path: ['path'] });
    }
    if (link.url === undefined && link.path === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: link.kind === 'workspace' ? 'a workspace link needs a url or a path' : 'link url must be a full URL',
        path: ['url'],
      });
    } else if (link.url === undefined && link.kind !== 'workspace') {
      // A path alone is only good for a workspace link (the check above already refused a
      // non-workspace path); every other kind still needs its own url even when it has a path.
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'link url must be a full URL', path: ['url'] });
    }
  })).max(HANDOFF_LIMITS.links, `handoff.links may have at most ${HANDOFF_LIMITS.links} items`).default([]),
  // Rare, so absent stays absent rather than normalised to null: every stored handoff reads as it did.
  stop: z.preprocess(
    (value) => (value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value),
    text('handoff.stop', HANDOFF_LIMITS.stop).optional(),
  ),
}).transform(({ stop, ...rest }) => (stop === undefined ? rest : { ...rest, stop }));

const NO_TEXT = '(no text)';

/**
 * A handoff for work a person wrote, who is not made to fill in YAML.
 *
 * The headline is the first sentence of their text, because that is what a
 * person usually leads with; when it is too long it is cut on a word boundary
 * so the card never shows half a word. Headings are dropped, since `# Results`
 * is a label and not something anyone meant as the outcome, and a paragraph
 * break ends a sentence even without a full stop. A document that is only
 * headings falls back to their text rather than showing nothing.
 */
export function deriveHandoff(source: string): ArtifactHandoff {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const isHeading = (line: string) => HEADING_RE.test(line);
  const prose = lines.filter((line) => !isHeading(line));
  const firstParagraph = paragraphsOf(prose)[0] ?? paragraphsOf(lines.filter(isHeading))[0] ?? '';
  return { headline: firstSentence(firstParagraph), points: [], needs: null, changed: [], links: [] };
}

const HEADING_RE = /^\s*#{1,6}(?:\s|$)/;
const LINE_MARKER_RE = /^\s*(?:#{1,6}(?:\s+|$)|[-*+]\s+|\d+[.)]\s+|>\s*)/;

/** Blank lines separate paragraphs; within one, lines are flattened into a single run of text. */
function paragraphsOf(lines: readonly string[]): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const text = current.join(' ').replace(/\s+/g, ' ').trim();
    if (text !== '') paragraphs.push(text);
    current = [];
  };
  for (const line of lines) {
    const content = line.replace(LINE_MARKER_RE, '').trim();
    if (content === '') flush(); else current.push(content);
  }
  flush();
  return paragraphs;
}

/*
 * Short words that end in a full stop without ending a sentence. Kept small on
 * purpose: a missed abbreviation only makes a headline longer, which the cut
 * below absorbs, while a wrong one would merge two real sentences.
 */
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'vs', 'etc', 'approx', 'mr', 'ms', 'dr']);

/**
 * Where the first sentence ends. A terminator ends it only at the end of the
 * text or before whitespace and a capital letter or digit, and a full stop
 * after an initial (`Garcia G.`) or a known abbreviation (`e.g.`) never does.
 * Those two were the ways a real person's text got cut mid-sentence.
 */
function sentenceEnd(text: string): number {
  for (const match of text.matchAll(/[.!?]+/g)) {
    const end = match.index + match[0].length;
    const after = text.slice(end);
    if (after !== '' && !/^\s+[\p{Lu}\p{N}]/u.test(after)) continue;
    if (match[0] === '.') {
      const word = /(\S+)$/.exec(text.slice(0, match.index))?.[1]?.replace(/^[("'\[]+/, '') ?? '';
      if (/^\p{Lu}$/u.test(word) || ABBREVIATIONS.has(word.toLowerCase())) continue;
    }
    return end;
  }
  return text.length;
}

function firstSentence(flat: string): string {
  if (flat === '') return NO_TEXT;
  const sentence = flat.slice(0, sentenceEnd(flat));
  const max = HANDOFF_LIMITS.headline;
  if (sentence.length <= max) return sentence;
  // Leave room for the ellipsis, then back up to the last space so no word is split.
  const room = sentence.slice(0, max - 1);
  // When the character after the room is a space, the room already ends on a whole word.
  const space = sentence[max - 1] === ' ' ? room.length : room.lastIndexOf(' ');
  const cut = (space > 0 ? room.slice(0, space) : room).trimEnd().replace(/[,;:]$/, '');
  return `${cut}…`;
}
