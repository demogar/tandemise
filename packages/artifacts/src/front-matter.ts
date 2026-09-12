import { Err, Ok, type Result } from '@tandemise/shared';

/**
 * A deliberately small YAML reader for artifact front matter.
 *
 * Artifacts are Markdown documents with a YAML header (MVP.md §15.2). The
 * header is machine-read, so it must be *narrow*: an agent that can emit
 * anchors, multi-document streams, block scalars, or merge keys is an agent
 * that can emit something the schema check has to guess about. Rather than pull
 * in a full YAML implementation and then have to defend against its surface,
 * this parser accepts exactly the shapes the artifact schemas use:
 *
 *   key: scalar
 *   key: [a, b]
 *   key:
 *     - scalar
 *   key:
 *     - subkey: scalar
 *       other: scalar
 *
 * Anything else is a parse error with a line number, which is a far better
 * failure than silently reading a structure the author did not intend.
 *
 * Known limitation, documented rather than papered over: `#` does not start a
 * comment when it appears after a value, because artifact titles legitimately
 * contain `#42`. Comments are only recognised on their own line.
 */
export interface FrontMatterDocument {
  readonly frontMatter: Readonly<Record<string, unknown>>;
  /** Everything after the closing `---`, with leading blank lines removed. */
  readonly body: string;
}

const FENCE = '---';

export function parseFrontMatterDocument(source: string): Result<FrontMatterDocument, string> {
  const normalized = source.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== FENCE) {
    return Err('missing opening `---` front-matter fence on line 1');
  }
  const closing = lines.findIndex((l, i) => i > 0 && l.trim() === FENCE);
  if (closing === -1) return Err('missing closing `---` front-matter fence');

  const parsed = parseFrontMatter(lines.slice(1, closing).join('\n'));
  if (!parsed.ok) return parsed;
  return Ok({
    frontMatter: parsed.value,
    body: lines.slice(closing + 1).join('\n').replace(/^\n+/, '').trimEnd(),
  });
}

export function parseFrontMatter(yaml: string): Result<Record<string, unknown>, string> {
  try {
    const lines: SourceLine[] = [];
    yaml.split('\n').forEach((raw, i) => {
      if (raw.trim() === '' || raw.trimStart().startsWith('#')) return;
      if (raw.includes('\t')) throw new Error(`line ${i + 1}: tabs are not valid YAML indentation`);
      lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trim(), lineNo: i + 1 });
    });
    if (lines.length === 0) return Ok({});

    const { value, next } = parseBlock(lines, 0, lines[0]!.indent);
    if (next !== lines.length) {
      throw new Error(`line ${lines[next]!.lineNo}: unexpected indentation`);
    }
    if (Array.isArray(value)) throw new Error('front matter must be a mapping, not a list');
    return Ok(value as Record<string, unknown>);
  } catch (e) {
    return Err(e instanceof Error ? e.message : String(e));
  }
}

interface SourceLine {
  readonly indent: number;
  readonly text: string;
  readonly lineNo: number;
}

interface Parsed {
  readonly value: unknown;
  readonly next: number;
}

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*))?$/;

function parseBlock(lines: readonly SourceLine[], start: number, indent: number): Parsed {
  return lines[start]!.text.startsWith('- ') || lines[start]!.text === '-'
    ? parseSequence(lines, start, indent)
    : parseMapping(lines, start, indent);
}

function parseMapping(lines: readonly SourceLine[], start: number, indent: number): Parsed {
  const out: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length && lines[i]!.indent >= indent) {
    const line = lines[i]!;
    if (line.indent > indent) throw new Error(`line ${line.lineNo}: unexpected indentation`);
    const m = KEY_RE.exec(line.text);
    if (!m) throw new Error(`line ${line.lineNo}: expected 'key: value', got '${line.text}'`);
    const key = m[1]!;
    const inline = m[2];
    if (inline !== undefined && inline.trim() !== '') {
      out[key] = parseScalarOrFlow(inline.trim(), line.lineNo);
      i += 1;
      continue;
    }
    // A nested block may be indented (standard) or, for sequences, sit at the
    // same column as its key - both spellings are common and both are valid.
    const child = lines[i + 1];
    if (child === undefined || (child.indent <= indent && !(child.indent === indent && child.text.startsWith('-')))) {
      out[key] = null;
      i += 1;
      continue;
    }
    const nested = parseBlock(lines, i + 1, child.indent);
    out[key] = nested.value;
    i = nested.next;
  }
  return { value: out, next: i };
}

function parseSequence(lines: readonly SourceLine[], start: number, indent: number): Parsed {
  const out: unknown[] = [];
  let i = start;
  while (i < lines.length && lines[i]!.indent === indent && (lines[i]!.text === '-' || lines[i]!.text.startsWith('- '))) {
    const line = lines[i]!;
    const rest = line.text === '-' ? '' : line.text.slice(2).trim();
    // Sub-lines of this item: everything indented deeper than the dash.
    const itemEnd = findItemEnd(lines, i + 1, indent);

    if (rest === '') {
      if (i + 1 >= itemEnd) throw new Error(`line ${line.lineNo}: list item has no value`);
      const nested = parseBlock(lines, i + 1, lines[i + 1]!.indent);
      out.push(nested.value);
      i = nested.next;
      continue;
    }
    if (KEY_RE.test(rest)) {
      // `- key: value` opens a mapping. Its column is wherever the item's own
      // continuation lines sit, so that both `- k: v` / 4-space and 6-space
      // continuations parse - YAML allows either and agents emit both.
      const itemIndent = i + 1 < itemEnd ? lines[i + 1]!.indent : indent + 2;
      const synthetic: SourceLine[] = [
        { indent: itemIndent, text: rest, lineNo: line.lineNo },
        ...lines.slice(i + 1, itemEnd),
      ];
      const mapped = parseMapping(synthetic, 0, itemIndent);
      if (mapped.next !== synthetic.length) {
        throw new Error(`line ${synthetic[mapped.next]!.lineNo}: unexpected indentation inside list item`);
      }
      out.push(mapped.value);
      i = itemEnd;
      continue;
    }
    if (i + 1 < itemEnd) throw new Error(`line ${lines[i + 1]!.lineNo}: unexpected content after a scalar list item`);
    out.push(parseScalarOrFlow(rest, line.lineNo));
    i += 1;
  }
  return { value: out, next: i };
}

function findItemEnd(lines: readonly SourceLine[], from: number, indent: number): number {
  let i = from;
  while (i < lines.length && lines[i]!.indent > indent) i += 1;
  return i;
}

function parseScalarOrFlow(raw: string, lineNo: number): unknown {
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) throw new Error(`line ${lineNo}: unterminated inline list`);
    const inner = raw.slice(1, -1).trim();
    if (inner === '') return [];
    return splitFlow(inner, lineNo).map((part) => parseScalar(part, lineNo));
  }
  if (raw.startsWith('{')) throw new Error(`line ${lineNo}: inline maps are not supported in artifact front matter`);
  return parseScalar(raw, lineNo);
}

/** Splits `a, "b, c", d` on top-level commas only. */
function splitFlow(input: string, lineNo: number): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of input) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === ',') { parts.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (quote) throw new Error(`line ${lineNo}: unterminated quoted string`);
  parts.push(current.trim());
  return parts.filter((p) => p !== '');
}

function parseScalar(raw: string, lineNo: number): unknown {
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) throw new Error(`line ${lineNo}: unterminated double-quoted string`);
    try {
      return JSON.parse(raw) as string;
    } catch {
      throw new Error(`line ${lineNo}: invalid escape sequence in ${raw}`);
    }
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) throw new Error(`line ${lineNo}: unterminated single-quoted string`);
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null' || raw === '~') return null;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  if (/^-?\d+%$/.test(raw)) return Number.parseInt(raw.slice(0, -1), 10);
  return raw;
}
