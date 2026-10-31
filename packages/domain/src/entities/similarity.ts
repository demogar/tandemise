/**
 * Lexical similarity for intake's dedupe (spec §5 step 4, plan Task 6).
 *
 * Task 4 lands `titleTokens` first: the YouTrack adapter's text search sends
 * these words to the tracker. Task 6 adds the scorer beside it.
 */

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'to', 'is', 'for', 'and', 'or', 'not', 'cannot', 'can', 'it', 'this', 'that', 'with']);

/**
 * A title's words: lowercased, split on anything but letters and digits,
 * without one-letter tokens and stopwords, each once, in order.
 */
export function titleTokens(s: string): readonly string[] {
  const out: string[] = [];
  for (const t of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length < 2 || STOPWORDS.has(t) || out.includes(t)) continue;
    out.push(t);
  }
  return out;
}
