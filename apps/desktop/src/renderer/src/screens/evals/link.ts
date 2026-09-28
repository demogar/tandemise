import type { EvalCandidate } from '@tandemise/domain';

export type EvalsTab = 'suites' | 'runs' | 'yours';

const TABS: readonly EvalsTab[] = ['suites', 'runs', 'yours'];

/** What the Evals screen reads from its query: which tab, suite and run are open, and a candidate to prefill. */
export interface EvalsQuery {
  readonly tab: EvalsTab;
  readonly suite: string | null;
  readonly run: string | null;
  /** True when the Runs tab should show the new-run form rather than a run. */
  readonly compose: boolean;
  readonly candidate: EvalCandidate | null;
}

/**
 * A link into the Evals screen. The state lives in the query, not in the
 * screen, so "Try on evals" on another screen can open the Runs tab with its
 * candidate already filled in.
 */
export function evalsHref(query: Partial<EvalsQuery>): string {
  const params = new URLSearchParams();
  params.set('tab', query.tab ?? 'suites');
  if (query.suite) params.set('suite', query.suite);
  if (query.run) params.set('run', query.run);
  if (query.compose) params.set('new', '1');
  if (query.candidate) params.set('candidate', encodeCandidate(query.candidate));
  return `/evals?${params.toString()}`;
}

export function parseEvalsQuery(search: string): EvalsQuery {
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  const candidate = decodeCandidate(params.get('candidate'));
  return {
    tab: TABS.includes(tab as EvalsTab) ? (tab as EvalsTab) : 'suites',
    suite: params.get('suite'),
    run: params.get('run'),
    compose: params.get('new') === '1' || candidate !== null,
    candidate,
  };
}

/** base64url of the candidate's JSON: a folder path or a role id is safe in a query only once encoded. */
function encodeCandidate(candidate: EvalCandidate): string {
  const bytes = new TextEncoder().encode(JSON.stringify(candidate));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A link that does not decode to a candidate opens an empty form rather than failing the screen. */
function decodeCandidate(value: string | null): EvalCandidate | null {
  if (!value) return null;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const kind = (parsed as { kind?: unknown }).kind;
    return kind === 'models' || kind === 'skills' || kind === 'setup' ? (parsed as EvalCandidate) : null;
  } catch {
    return null;
  }
}
