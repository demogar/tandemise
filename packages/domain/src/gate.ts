import { Err, Ok, type Result } from '@tandemise/shared';

/**
 * Quality gates (MVP.md §17.2).
 *
 * Gates are written as small boolean expressions over *facts the orchestrator
 * measured*, e.g. `checks.typecheck == PASS && review.blocking_findings == 0`.
 * They are deliberately not arbitrary code: a gate must be inspectable in the
 * UI, explainable to the user when it fails, and impossible for an agent to
 * satisfy by asserting that it did. The grammar below is the whole language.
 *
 *   expr    := or
 *   or      := and ( '||' and )*
 *   and     := cmp ( '&&' cmp )*
 *   cmp     := primary ( ('=='|'!='|'>'|'>='|'<'|'<=') primary )?
 *   primary := '(' expr ')' | '!' primary | literal | path
 *   path    := ident ( '.' ident )*
 *
 * Values are resolved from a flat `GateFacts` map. An unknown path resolves to
 * `undefined`, which compares false against everything - a missing fact never
 * silently passes a gate.
 */
export type GateExpression = string;

export type GateValue = string | number | boolean | undefined;
export type GateFacts = Readonly<Record<string, GateValue>>;

export interface GateOutcome {
  readonly expression: GateExpression;
  readonly passed: boolean;
  /** Human-readable reason, shown verbatim in the UI when a gate blocks. */
  readonly detail: string;
  /** Every fact the expression actually read, for the "why" panel. */
  readonly facts: Readonly<Record<string, GateValue>>;
}

export function evaluateGate(expression: GateExpression, facts: GateFacts): GateOutcome {
  const used: Record<string, GateValue> = {};
  const parsed = parse(expression);
  if (!parsed.ok) {
    return { expression, passed: false, detail: `Invalid gate expression: ${parsed.error}`, facts: {} };
  }
  let value: GateValue;
  try {
    value = evaluate(parsed.value, facts, used);
  } catch (e) {
    return { expression, passed: false, detail: `Gate evaluation failed: ${String(e)}`, facts: used };
  }
  // `truthy` rather than `=== true` so a bare fact reference (`checks.tests`)
  // passes when the measured value is the string "PASS".
  const passed = truthy(value);
  return {
    expression,
    passed,
    detail: passed ? 'All gate conditions met.' : explainFailure(parsed.value, facts),
    facts: used,
  };
}

/** Validates syntax without needing facts - used when a plan is accepted. */
export function validateGate(expression: GateExpression): Result<true, string> {
  const parsed = parse(expression);
  return parsed.ok ? Ok(true) : Err(parsed.error);
}

/** Every fact path an expression references, so the engine knows what to measure. */
export function gateDependencies(expression: GateExpression): readonly string[] {
  const parsed = parse(expression);
  if (!parsed.ok) return [];
  const out = new Set<string>();
  collectPaths(parsed.value, out);
  return [...out];
}

// ---------------------------------------------------------------- AST + parser

type Node =
  | { kind: 'literal'; value: GateValue }
  | { kind: 'path'; path: string }
  | { kind: 'not'; operand: Node }
  | { kind: 'binary'; op: BinaryOp; left: Node; right: Node };

type BinaryOp = '&&' | '||' | '==' | '!=' | '>' | '>=' | '<' | '<=';

type Token = { t: 'op'; v: string } | { t: 'ident'; v: string } | { t: 'num'; v: number } | { t: 'str'; v: string };

const OPERATORS = ['&&', '||', '==', '!=', '>=', '<=', '>', '<', '!', '(', ')'] as const;

function tokenize(src: string): Result<Token[], string> {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end === -1) return Err(`unterminated string at ${i}`);
      tokens.push({ t: 'str', v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) { tokens.push({ t: 'op', v: op }); i += op.length; continue; }
    const m = /^(\d+(?:\.\d+)?%?|[A-Za-z_][A-Za-z0-9_.]*)/.exec(src.slice(i));
    if (!m) return Err(`unexpected character '${ch}' at ${i}`);
    const raw = m[1]!;
    if (/^\d/.test(raw)) {
      tokens.push({ t: 'num', v: raw.endsWith('%') ? Number(raw.slice(0, -1)) : Number(raw) });
    } else {
      tokens.push({ t: 'ident', v: raw });
    }
    i += raw.length;
  }
  return Ok(tokens);
}

function parse(src: string): Result<Node, string> {
  const lexed = tokenize(src);
  if (!lexed.ok) return lexed;
  const tokens = lexed.value;
  if (tokens.length === 0) return Err('empty expression');
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const eatOp = (v: string): boolean => {
    const t = peek();
    if (t?.t === 'op' && t.v === v) { pos++; return true; }
    return false;
  };

  function parseOr(): Node {
    let left = parseAnd();
    while (eatOp('||')) left = { kind: 'binary', op: '||', left, right: parseAnd() };
    return left;
  }
  function parseAnd(): Node {
    let left = parseCmp();
    while (eatOp('&&')) left = { kind: 'binary', op: '&&', left, right: parseCmp() };
    return left;
  }
  function parseCmp(): Node {
    const left = parsePrimary();
    for (const op of ['==', '!=', '>=', '<=', '>', '<'] as const) {
      if (eatOp(op)) return { kind: 'binary', op, left, right: parsePrimary() };
    }
    return left;
  }
  function parsePrimary(): Node {
    if (eatOp('!')) return { kind: 'not', operand: parsePrimary() };
    if (eatOp('(')) {
      const inner = parseOr();
      if (!eatOp(')')) throw new Error('expected )');
      return inner;
    }
    const t = peek();
    if (!t) throw new Error('unexpected end of expression');
    pos++;
    if (t.t === 'num') return { kind: 'literal', value: t.v };
    if (t.t === 'str') return { kind: 'literal', value: t.v };
    if (t.t === 'ident') {
      if (t.v === 'true') return { kind: 'literal', value: true };
      if (t.v === 'false') return { kind: 'literal', value: false };
      // Bare PASS/FAIL/SKIP read as string literals so `checks.x == PASS` works
      // without quoting - the form that appears throughout MVP.md.
      if (/^(PASS|FAIL|SKIP|APPROVED|REJECTED|PENDING)$/.test(t.v)) return { kind: 'literal', value: t.v };
      return { kind: 'path', path: t.v };
    }
    throw new Error(`unexpected token ${JSON.stringify(t)}`);
  }

  try {
    const node = parseOr();
    if (pos !== tokens.length) return Err(`unexpected trailing input at token ${pos}`);
    return Ok(node);
  } catch (e) {
    return Err(e instanceof Error ? e.message : String(e));
  }
}

function evaluate(node: Node, facts: GateFacts, used: Record<string, GateValue>): GateValue {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'path': {
      const v = facts[node.path];
      used[node.path] = v;
      return v;
    }
    case 'not':
      return !truthy(evaluate(node.operand, facts, used));
    case 'binary': {
      if (node.op === '&&') {
        // Both sides are evaluated so the failure explanation can name every
        // unmet condition rather than only the first.
        const l = truthy(evaluate(node.left, facts, used));
        const r = truthy(evaluate(node.right, facts, used));
        return l && r;
      }
      if (node.op === '||') {
        const l = truthy(evaluate(node.left, facts, used));
        const r = truthy(evaluate(node.right, facts, used));
        return l || r;
      }
      const l = evaluate(node.left, facts, used);
      const r = evaluate(node.right, facts, used);
      return compare(node.op, l, r);
    }
  }
}

function compare(op: Exclude<BinaryOp, '&&' | '||'>, l: GateValue, r: GateValue): boolean {
  if (op === '==') return normalize(l) === normalize(r);
  if (op === '!=') return normalize(l) !== normalize(r);
  if (typeof l !== 'number' || typeof r !== 'number') return false;
  switch (op) {
    case '>': return l > r;
    case '>=': return l >= r;
    case '<': return l < r;
    case '<=': return l <= r;
  }
}

/** `true`/`"PASS"` and `false`/`"FAIL"` are the same fact wearing two hats. */
function normalize(v: GateValue): GateValue {
  if (v === 'PASS') return true;
  if (v === 'FAIL') return false;
  return v;
}

function truthy(v: GateValue): boolean {
  return normalize(v) === true;
}

function collectPaths(node: Node, out: Set<string>): void {
  if (node.kind === 'path') out.add(node.path);
  else if (node.kind === 'not') collectPaths(node.operand, out);
  else if (node.kind === 'binary') { collectPaths(node.left, out); collectPaths(node.right, out); }
}

/**
 * Names the specific conjuncts that failed, so the UI can say *why* a gate
 * blocked rather than only that it did. Walks the top-level `&&` chain and
 * reports each unmet branch - reporting only the first would hide the second
 * problem until the first was fixed.
 */
function explainFailure(node: Node, facts: GateFacts): string {
  const unmet: string[] = [];
  const walk = (n: Node): void => {
    if (n.kind === 'binary' && n.op === '&&') { walk(n.left); walk(n.right); return; }
    const probe: Record<string, GateValue> = {};
    let value: GateValue;
    try { value = evaluate(n, facts, probe); } catch { value = undefined; }
    if (truthy(value)) return;
    unmet.push(render(n, facts));
  };
  walk(node);
  if (unmet.length === 0) return 'Gate did not evaluate to true.';
  return `Not met: ${unmet.join('; ')}`;
}

function render(node: Node, facts: GateFacts): string {
  switch (node.kind) {
    case 'literal': return String(node.value);
    case 'path': {
      const v = facts[node.path];
      return `${node.path} is ${v === undefined ? 'not measured' : JSON.stringify(v)}`;
    }
    case 'not': return `not (${render(node.operand, facts)})`;
    case 'binary': {
      // A comparison of a measurement against a requirement is rendered as a
      // sentence, not as the expression that produced it. Composing the two
      // halves mechanically gave `checks.tests is "FAIL" != FAIL`, which reads
      // as a contradiction - and this string is not decoration: it becomes the
      // task's status reason AND the retry feedback the next agent is asked to
      // act on. One real mission spent 13 attempts being told its tests failed.
      if (COMPARISONS.has(node.op) && node.left.kind === 'path' && node.right.kind === 'literal') {
        return `${node.left.path} is ${plain(facts[node.left.path])}, needs ${requirement(node.op, node.right.value)}`;
      }
      return `${render(node.left, facts)} ${node.op} ${render(node.right, facts)}`;
    }
  }
}

const COMPARISONS = new Set<BinaryOp>(['==', '!=', '>', '>=', '<', '<=']);

function plain(value: GateValue): string {
  return value === undefined ? 'not measured' : String(value);
}

/** What the gate wanted, in the words a person would use to ask for it. */
function requirement(op: BinaryOp, expected: GateValue): string {
  if (op === '==') return String(expected);
  if (op === '!=') return `anything but ${expected}`;
  return `${op} ${expected}`;
}
