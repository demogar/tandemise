import type { BrainMemory, BrainRepoPort, LedgerEvent, LedgerProblem } from '@tandemise/domain';
import { foldLedger, parseLedgerFile } from '@tandemise/domain';
import { BRAIN_LEDGER } from './layout.js';

/** Folds are pure and keyed by commit, so a handful of recent ones is all a daemon re-reads. */
const CACHE_SIZE = 8;

export interface LedgerAt {
  readonly events: readonly LedgerEvent[];
  readonly problems: readonly LedgerProblem[];
}

/**
 * The ledger at a commit (#51 spec §5): every `memory/ledger/**.jsonl` read
 * with `git show`, never from the working tree, so a run reads one fixed
 * commit even while a pull moves HEAD. Small LRU by sha.
 */
export class LedgerReader {
  readonly #cache = new Map<string, LedgerAt>();

  constructor(private readonly repo: Pick<BrainRepoPort, 'listAt' | 'readAt'>) {}

  async eventsAt(clonePath: string, sha: string): Promise<LedgerAt> {
    const key = `${clonePath}\u0000${sha}`;
    const hit = this.#cache.get(key);
    if (hit !== undefined) {
      this.#cache.delete(key);
      this.#cache.set(key, hit);
      return hit;
    }
    const events: LedgerEvent[] = [];
    const problems: LedgerProblem[] = [];
    for (const path of await this.repo.listAt(clonePath, sha, BRAIN_LEDGER)) {
      if (!path.endsWith('.jsonl')) continue;
      const text = await this.repo.readAt(clonePath, sha, path);
      if (text === null) continue;
      const parsed = parseLedgerFile(text, path);
      events.push(...parsed.events);
      problems.push(...parsed.problems);
    }
    const value = { events, problems };
    this.#cache.set(key, value);
    while (this.#cache.size > CACHE_SIZE) this.#cache.delete(this.#cache.keys().next().value as string);
    return value;
  }

  async memoryAt(clonePath: string, sha: string, now: string): Promise<BrainMemory> {
    const { events, problems } = await this.eventsAt(clonePath, sha);
    return foldLedger(events, problems, now);
  }
}
