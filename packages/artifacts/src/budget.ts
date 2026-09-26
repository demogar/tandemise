import type { ArtifactType } from '@tandemise/domain';
import { stripFrontMatter } from './strip-front-matter.js';

/**
 * Word budgets for each type's main body, everything before `## Appendix`
 * (P1 spec §2).
 *
 * Measured on a real mission, a design brief averaged 35 KB, which nobody
 * reads. The numbers follow what each type is for: a decision or a release is
 * a short statement, a plan has to carry its steps.
 */
export const WORD_BUDGETS: Readonly<Record<ArtifactType, number>> = {
  ReleaseCandidate: 300,
  DecisionRecord: 300,
  MissionPlan: 300,
  // What was understood and assumed: the proposals and questions themselves are front matter.
  Refinement: 300,
  ProblemBrief: 400,
  QAPlan: 400,
  Evidence: 400,
  DesignBrief: 500,
  ReviewReport: 500,
  QAReport: 500,
  ChangeSet: 500,
  ProductSpec: 600,
  FinanceReport: 600,
  StatusReport: 600,
  ArchitecturePlan: 800,
  ImplementationPlan: 800,
};

export interface BodyMeasure {
  readonly mainWords: number;
  readonly appendixWords: number;
  /** Lines inside fenced code blocks and table rows, reported against a soft cap but never enforced. */
  readonly codeLines: number;
  readonly hasAppendix: boolean;
}

const APPENDIX_RE = /^##\s+Appendix\b/i;
const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/;
// A closing fence is bare: the fence characters and nothing else, so a line with an info string never closes one.
const FENCE_CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
// Markers that start a line but say nothing: headings, bullets, numbered items and quotes.
const LINE_MARKER_RE = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/;
const WORD_RE = /[\p{L}\p{N}]/u;

type LineKind = 'prose' | 'code' | 'fence' | 'appendix';

/**
 * Classifies each line once, so measuring and splitting agree on where code
 * fences and tables are and where the appendix starts. An `## Appendix` inside
 * a fence is code, not a heading.
 *
 * Fences follow CommonMark closely enough for real documents: a fence closes
 * only on a bare run of the same character at least as long as the one that
 * opened it, so a Markdown example that shows a shorter fence stays code.
 * Tables are pipe rows, plus GFM tables written without leading pipes, which
 * are recognised by their separator row. Miscounting either would inflate the
 * word count and run a tighten pass nobody needed.
 */
function classify(lines: readonly string[]): LineKind[] {
  const kinds: LineKind[] = [];
  let fence: { char: string; length: number } | null = null;
  let inTable = false;
  lines.forEach((line, i) => {
    if (fence !== null) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close !== null && close[1]![0] === fence.char && close[1]!.length >= fence.length) {
        fence = null;
        kinds.push('fence');
      } else kinds.push('code');
      return;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open !== null) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      inTable = false;
      kinds.push('fence');
      return;
    }
    if (inTable && line.includes('|')) { kinds.push('code'); return; }
    inTable = false;
    if (TABLE_ROW_RE.test(line) || TABLE_SEPARATOR_RE.test(line)) { kinds.push('code'); return; }
    if (line.includes('|') && TABLE_SEPARATOR_RE.test(lines[i + 1] ?? '')) {
      inTable = true;
      kinds.push('code');
      return;
    }
    kinds.push(APPENDIX_RE.test(line) ? 'appendix' : 'prose');
  });
  return kinds;
}

function linesOf(markdown: string): string[] {
  return stripFrontMatter(markdown).replace(/\r\n/g, '\n').split('\n');
}

function wordsIn(line: string): number {
  return line.replace(LINE_MARKER_RE, '').split(/\s+/).filter((token) => WORD_RE.test(token)).length;
}

/**
 * Measures an artifact body. Words are whitespace-separated tokens with a
 * letter or digit in them; fenced code and tables are excluded from words
 * because they are read differently from prose, and are counted as lines
 * instead. A leading front-matter block is ignored, so passing the whole
 * document measures the same as passing its body.
 */
export function measureBody(markdown: string): BodyMeasure {
  const lines = linesOf(markdown);
  const kinds = classify(lines);
  const appendixAt = kinds.indexOf('appendix');
  let mainWords = 0;
  let appendixWords = 0;
  let codeLines = 0;
  lines.forEach((line, i) => {
    const kind = kinds[i];
    if (kind === 'code') { codeLines += 1; return; }
    // Fence markers carry no words, and only the first appendix heading is the
    // divider; a later one is an ordinary heading whose words count.
    if (kind === 'fence' || i === appendixAt) return;
    if (appendixAt !== -1 && i > appendixAt) appendixWords += wordsIn(line);
    else mainWords += wordsIn(line);
  });
  return { mainWords, appendixWords, codeLines, hasAppendix: appendixAt !== -1 };
}

export function budgetFor(type: ArtifactType): number {
  return WORD_BUDGETS[type];
}

/** The appendix may be twice the budget, because the UI keeps it collapsed. */
export function overBudget(type: ArtifactType, m: BodyMeasure): boolean {
  const budget = budgetFor(type);
  return m.mainWords > budget || m.appendixWords > 2 * budget;
}

export interface ArtifactMeasure extends BodyMeasure {
  readonly budget: number;
  readonly overBudget: boolean;
}

/**
 * A body measured against its type's budget in one call, which is the shape
 * the engine's measuring port takes: the engine may not import this package,
 * and binding one function keeps every composition root's binding identical.
 */
export function measureArtifact(type: ArtifactType, markdown: string): ArtifactMeasure {
  const measure = measureBody(markdown);
  return { ...measure, budget: budgetFor(type), overBudget: overBudget(type, measure) };
}

/**
 * Splits a body at its first `## Appendix` heading, so a reader can show the
 * main body and keep the appendix collapsed. The heading itself belongs to
 * neither part.
 */
export function splitAppendix(markdown: string): { main: string; appendix: string | null } {
  const lines = linesOf(markdown);
  const at = classify(lines).indexOf('appendix');
  if (at === -1) return { main: lines.join('\n').trim(), appendix: null };
  return { main: lines.slice(0, at).join('\n').trim(), appendix: lines.slice(at + 1).join('\n').trim() };
}
