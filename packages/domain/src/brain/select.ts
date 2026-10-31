import type { BrainEntry, BrainMemory, EntryScope, Iso } from './ledger.js';
import { isLoadable } from './ledger.js';

/**
 * Which lessons a task loads (#51 spec §10). Deterministic: scope match,
 * then counters, then recency. No embeddings (MVP.md §14.3).
 */

/** Lessons compete for this much of the prompt; rules don't (they load always). */
export const LESSON_BUDGET_CHARS = 4_000;
/** The rest of the matching lessons as one line each, at most this many. */
export const INDEX_MAX_LINES = 40;
/** An index line is the start of the lesson; `brain.read` fetches the rest. */
export const INDEX_LINE_CHARS = 80;

/** More specific scopes rank first: a lesson about this step beats one about the project. */
export const SPECIFICITY = { step: 4, role: 3, paths: 2, repo: 1, project: 0 } as const;
export type ScopeMatch = keyof typeof SPECIFICITY;

export interface TaskScope {
  /** Brain repository names the task touches. */
  readonly repos: readonly string[];
  readonly role: string;
  readonly step: string;
  /** Files named in the task's inputs, as `repo:path` or plain paths. */
  readonly files: readonly string[];
}

/** `*` within a segment, `**` across segments, `?` one character. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function fileMatches(glob: string, file: string): boolean {
  const re = globToRegExp(glob);
  const colon = file.indexOf(':');
  const path = colon > 0 && !file.slice(0, colon).includes('/') ? file.slice(colon + 1) : file;
  return re.test(path) || re.test(file);
}

/**
 * How a lesson's scope fits a task, or null when it doesn't. Every field the
 * scope names must fit; the most specific one names the match.
 */
export function matchScope(scope: EntryScope, task: TaskScope): ScopeMatch | null {
  if (scope.repo !== undefined && !task.repos.includes(scope.repo)) return null;
  if (scope.role !== undefined && scope.role !== task.role) return null;
  if (scope.step !== undefined && scope.step !== task.step) return null;
  if (scope.paths !== undefined && scope.paths.length > 0 && !scope.paths.some((g) => task.files.some((f) => fileMatches(g, f)))) return null;
  if (scope.step !== undefined) return 'step';
  if (scope.role !== undefined) return 'role';
  if (scope.paths !== undefined && scope.paths.length > 0) return 'paths';
  if (scope.repo !== undefined) return 'repo';
  return 'project';
}

export interface BrainSelection {
  readonly lessons: readonly { readonly id: string; readonly text: string; readonly net: number }[];
  readonly index: readonly { readonly id: string; readonly title: string }[];
}

export function selectBrain(memory: BrainMemory, task: TaskScope, now: Iso): BrainSelection {
  const ranked = memory.entries
    .filter((e) => isLoadable(e, now))
    .flatMap((e) => {
      const m = matchScope(e.scope, task);
      return m === null ? [] : [{ e, rank: SPECIFICITY[m] }];
    })
    .sort((a, b) => b.rank - a.rank || b.e.net - a.e.net || cmpDesc(a.e, b.e) || (a.e.id < b.e.id ? -1 : 1));
  const lessons: { id: string; text: string; net: number }[] = [];
  const index: { id: string; title: string }[] = [];
  let used = 0;
  let full = false;
  for (const { e } of ranked) {
    if (!full && used + e.text.length <= LESSON_BUDGET_CHARS) {
      lessons.push({ id: e.id, text: e.text, net: e.net });
      used += e.text.length;
      continue;
    }
    // Once one lesson does not fit, the rest are index lines: rank order holds.
    full = true;
    if (index.length < INDEX_MAX_LINES) index.push({ id: e.id, title: e.text.slice(0, INDEX_LINE_CHARS) });
  }
  return { lessons, index };
}

function cmpDesc(a: BrainEntry, b: BrainEntry): number {
  return a.lastConfirmedAt < b.lastConfirmedAt ? 1 : a.lastConfirmedAt > b.lastConfirmedAt ? -1 : 0;
}
