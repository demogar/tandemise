/**
 * Lexical similarity for intake's dedupe (spec §5 step 4, plan Task 6).
 *
 * `titleTokens` is also what the YouTrack adapter's text search sends to the
 * tracker (Ruling 8), so the candidates it finds are scored on the same words.
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

/** A title that starts with an error type, such as `TypeError: …` (spec §5 step 4, "error type"). */
const ERROR_TYPE = /^([A-Z][A-Za-z]*(?:Error|Exception))\b/;

/**
 * The default `IntakeSimilarity` (spec §5 step 4, plan Task 6): deterministic
 * and lexical, so an unsure match becomes an Inbox decision instead of a guess.
 *
 * 1. A candidate whose description holds the signal's URL is the same item: 1.
 * 2. Otherwise the Jaccard index of the two titles' tokens; when both titles
 *    start with an error type, `0.8 × Jaccard + 0.2` for the same type.
 * 3. Rounded to 2 decimals, so thresholds compare against what people see.
 */
export function lexicalSimilarity(
  a: { readonly title: string; readonly description?: string | null; readonly url: string },
  b: { readonly title: string; readonly description: string },
): number {
  // An empty URL would be "contained" in every description.
  if (a.url !== '' && b.description.includes(a.url)) return 1;
  const ta = new Set(titleTokens(a.title));
  const tb = new Set(titleTokens(b.title));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  const j = union === 0 ? 0 : shared / union;
  const ea = ERROR_TYPE.exec(a.title)?.[1];
  const eb = ERROR_TYPE.exec(b.title)?.[1];
  const score = ea !== undefined && eb !== undefined ? 0.8 * j + 0.2 * (ea === eb ? 1 : 0) : j;
  return Math.round(score * 100) / 100;
}
