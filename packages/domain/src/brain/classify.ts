/**
 * How a change to the brain may land (#51 spec §8), decided by code from the
 * diff and never by the model that proposed it:
 *
 *  - `small`: only lines added to rules files or to a role's instructions
 *    body. May apply on its own when the project opts in and evals pass.
 *  - `structural`: anything else. Always a pull request a person reviews.
 *  - `refused`: anything under `evals/`. Only a person changes the evals.
 */

export interface BrainDiffEntry {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface BrainClassification {
  readonly class: 'small' | 'structural' | 'refused';
  readonly reasons: readonly string[];
}

export const EVALS_CHANGE_REFUSAL = 'The evals folder can only be changed by a person.';
export const RELAXES_APPROVAL = 'Removes or relaxes an approval or a gate.';
export const ADDS_CAPABILITY = 'Adds a capability or an integration.';

const RULES = /^memory\/rules\/[^/]+\.md$/;
const ROLE = /^factory\/roles\/([^/]+)\.md$/;
const WORKFLOW = /^factory\/workflows\/([^/]+)\.(ya?ml|json)$/;

const lines = (text: string | null): string[] => (text ?? '').replace(/\r\n/g, '\n').split('\n').filter((l, i, all) => !(i === all.length - 1 && l === ''));

/** True when every line of `before` appears in `after`, in order: lines were only added. */
function onlyAdded(before: string | null, after: string | null): boolean {
  const a = lines(before);
  const b = lines(after);
  let j = 0;
  for (const line of a) {
    while (j < b.length && b[j] !== line) j++;
    if (j === b.length) return false;
    j++;
  }
  return true;
}

function splitFront(text: string | null): { front: string; body: string | null } {
  const t = (text ?? '').replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) return { front: '', body: text === null ? null : t };
  const end = t.indexOf('\n---', 4);
  if (end === -1) return { front: t, body: '' };
  const after = t.indexOf('\n', end + 4);
  return { front: t.slice(4, end + 1), body: after === -1 ? '' : t.slice(after + 1) };
}

/** Lines that name an approval, a gate or autonomy: removing or changing one relaxes the factory. */
const GUARD_LINE = /(approvals?|approvalPolicy|completionGate|gate|beforeStart|onCompletion|autonomy|planApproval|localCodeChanges|externalWrites|productionRelease|financialActions)\s*:/;

function guardLines(text: string | null): string[] {
  const out: string[] = [];
  const all = lines(text);
  for (let i = 0; i < all.length; i++) {
    const l = all[i]!;
    if (!GUARD_LINE.test(l)) continue;
    // A block value (`approvals:` then `- plan`) counts its items with it.
    out.push(l.trim());
    const indent = l.length - l.trimStart().length;
    for (let k = i + 1; k < all.length; k++) {
      const next = all[k]!;
      const nIndent = next.length - next.trimStart().length;
      if (next.trim() === '' || nIndent <= indent) break;
      out.push(`${l.trim()} ${next.trim()}`);
    }
  }
  return out;
}

function relaxesGuards(before: string | null, after: string | null): boolean {
  const kept = new Set(guardLines(after));
  return guardLines(before).some((l) => !kept.has(l));
}

const CAPABILITY_LINE = /^\s*(-\s+[a-z]+\.[a-z_.]+|capabilities:\s*\[.+\])\s*$/;

function addsCapability(before: string | null, after: string | null): boolean {
  const had = new Set(lines(before).map((l) => l.trim()));
  return lines(after).some((l) => CAPABILITY_LINE.test(l) && !had.has(l.trim()));
}

export function classifyBrainChange(diff: readonly BrainDiffEntry[]): BrainClassification {
  const changed = diff.filter((d) => d.before !== d.after);
  if (changed.some((d) => d.path === 'evals' || d.path.startsWith('evals/'))) {
    return { class: 'refused', reasons: [EVALS_CHANGE_REFUSAL] };
  }
  const reasons: string[] = [];
  const add = (r: string): void => { if (!reasons.includes(r)) reasons.push(r); };
  for (const d of changed) {
    const role = ROLE.exec(d.path);
    const workflow = WORKFLOW.exec(d.path);
    if (RULES.test(d.path)) {
      if (!onlyAdded(d.before, d.after)) add(`Removes or rewords a line in ${d.path}.`);
    } else if (role !== null) {
      const a = splitFront(d.before);
      const b = splitFront(d.after);
      if (d.before !== null && a.front !== b.front) {
        add(`Changes ${role[1]}'s settings (model, skills, capabilities or isolation).`);
        if (addsCapability(a.front, b.front)) add(ADDS_CAPABILITY);
      }
      if (d.before === null) add(`Changes ${role[1]}'s settings (model, skills, capabilities or isolation).`);
      if (!onlyAdded(a.body, b.body)) add(`Removes or rewords a line in ${d.path}.`);
    } else if (workflow !== null) {
      add(`Changes the workflow ${workflow[1]}.`);
      if (relaxesGuards(d.before, d.after)) add(RELAXES_APPROVAL);
    } else if (d.path === 'factory/tandemise.yaml') {
      add('Changes project settings.');
      if (relaxesGuards(d.before, d.after)) add(RELAXES_APPROVAL);
    } else if (d.path === 'factory/tracker.yaml' || d.path === 'factory/intake.yaml') {
      add('Changes the tracker mapping.');
    } else if (d.path === 'factory/mcps.yaml') {
      add('Changes the MCPs the project needs.');
      if (lines(d.after).length > lines(d.before).length || d.before === null) add(ADDS_CAPABILITY);
    } else if (d.path === 'factory/routines.yaml') {
      add('Changes routines.');
    } else if (d.path === 'factory/issues.yaml') {
      add('Changes issue settings.');
    } else if (d.path === 'factory/skills.lock' || d.path.startsWith('skills/')) {
      add('Changes pinned skills.');
    } else if (d.path === 'brain.yaml') {
      add('Changes brain.yaml.');
    } else {
      add(`Changes ${d.path}.`);
    }
  }
  return reasons.length === 0 ? { class: 'small', reasons: ['Only adds lines to rules or role instructions.'] } : { class: 'structural', reasons };
}
