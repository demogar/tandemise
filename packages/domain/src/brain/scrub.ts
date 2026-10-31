import { redactSecrets } from '@tandemise/shared';

/**
 * Scrubbing for every text the daemon writes into a brain's memory (#51 spec
 * §1): ledger entries, rules and decisions. Factory files go through the P15
 * `Scrubber` instead, which keeps `${SECRET_n}` placeholders.
 */

/** What a person sees when a lesson was nothing but a secret. */
export const BRAIN_SECRET_REFUSAL = "A lesson can't contain a secret; it was left out.";

/** What a person sees when a lesson names a path outside every repository. */
export const BRAIN_PATH_REFUSAL = "A lesson can't name a path on your machine. Name the file inside its repository instead.";

/** The marker a redacted secret leaves in a brain text. */
export const BRAIN_REDACTED = '[redacted secret]';

// `redactSecrets` keeps a recognisable prefix (`gh«redacted»`); in the brain
// the whole token goes, so a reader can't even tell which kind it was.
const REDACTED_TOKEN = /(?:sk-ant-|sk-|gh|github_pat_|figd_|xox|AKIA|jwt)?«redacted»/g;

// A token that starts with `/` or `~/` and has at least two segments, or a
// Windows drive path. `/tmp` alone is a word, `/etc/hosts` is a path.
const ABSOLUTE_PATH = /(^|[\s'"`(<[=,])(~?\/[^\s'"`)>\]/,;]+\/[^\s'"`)>\],;]*|[A-Za-z]:\\[^\s'"`]*)/;

export type ScrubResult = { readonly text: string } | { readonly refused: string };

export function scrubForBrain(text: string, repos: readonly { readonly name: string; readonly path: string }[]): ScrubResult {
  let out = redactSecrets(text).replace(REDACTED_TOKEN, BRAIN_REDACTED);
  const byLength = [...repos].filter((r) => r.path.length > 1).sort((a, b) => b.path.length - a.path.length);
  for (const repo of byLength) {
    const prefix = repo.path.endsWith('/') ? repo.path : `${repo.path}/`;
    out = out.split(prefix).join(`${repo.name}:`);
  }
  if (ABSOLUTE_PATH.test(out)) return { refused: BRAIN_PATH_REFUSAL };
  if (out.split(BRAIN_REDACTED).join('').trim().length === 0) return { refused: BRAIN_SECRET_REFUSAL };
  return { text: out };
}
