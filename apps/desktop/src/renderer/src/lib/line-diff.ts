export type DiffLine = { readonly kind: 'same' | 'added' | 'removed'; readonly text: string };

/**
 * The most lines on either side of the changed middle that a comparison takes
 * on. The table is quadratic, so past this a comparison would stall the
 * renderer; artifact bodies sit far below it, and the reader says so rather
 * than freeze on the rare one that does not.
 */
export const MAX_DIFF_LINES = 2000;

/**
 * A line diff by longest common subsequence, or null when the changed middle is
 * too large to compare. Artifact bodies are a few hundred lines at most, so the
 * quadratic table is cheaper than a dependency.
 *
 * The lines both versions share at the start and at the end are taken off
 * first: a round usually edits a few lines in the middle, and the table then
 * covers only those.
 */
export function lineDiff(before: string, after: string): readonly DiffLine[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length > MAX_DIFF_LINES || midB.length > MAX_DIFF_LINES) return null;

  const lcs: number[][] = Array.from({ length: midA.length + 1 }, () => new Array<number>(midB.length + 1).fill(0));
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      out.push({ kind: 'same', text: midA[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: 'removed', text: midA[i++]! });
    else out.push({ kind: 'added', text: midB[j++]! });
  }
  while (i < midA.length) out.push({ kind: 'removed', text: midA[i++]! });
  while (j < midB.length) out.push({ kind: 'added', text: midB[j++]! });
  for (const text of a.slice(endA)) out.push({ kind: 'same', text });
  return out;
}
