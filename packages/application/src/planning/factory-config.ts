import {
  parseMergePolicy, parsePlannerConfig, parseRoutingConfig,
  type MergePolicyOrError, type PlannerConfig, type RoutingConfig,
} from '@tandemise/domain';
import type { FactoryConfigSourcePort, FactoryFileName } from '../ports.js';
import { SHIPPED_PLANNER } from './defaults/planner.js';
import { SHIPPED_ROUTING } from './defaults/routing.js';
import { SHIPPED_MERGE } from './defaults/merge.js';

/**
 * The factory's three files, read and parsed (#53 §3, §6.1, §8.3). A bad
 * planner rule is dropped and reported; a broken routing file routes nothing;
 * a broken merge policy stays `{ error }` and every pull request asks. Nothing
 * here ever falls back to a policy that could merge.
 */
export interface FactoryConfig {
  readonly planner: PlannerConfig;
  readonly routing: RoutingConfig;
  readonly merge: MergePolicyOrError;
  readonly problems: readonly { readonly file: FactoryFileName; readonly path: string; readonly message: string }[];
  readonly refs: Readonly<Record<FactoryFileName, string>>;
  readonly origins: Readonly<Record<FactoryFileName, 'project' | 'home' | 'shipped'>>;
  readonly paths: Readonly<Record<FactoryFileName, string | null>>;
}

export const SHIPPED_FILES: Readonly<Record<FactoryFileName, unknown>> = {
  planner: SHIPPED_PLANNER,
  routing: SHIPPED_ROUTING,
  merge: SHIPPED_MERGE,
};

/** The shipped planner, parsed once. */
export const SHIPPED_PLANNER_CONFIG: PlannerConfig = parsePlannerConfig(SHIPPED_PLANNER).config;

export async function loadFactoryConfig(source: FactoryConfigSourcePort, repositoryPaths: readonly string[]): Promise<FactoryConfig> {
  const [planner, routing, merge] = await Promise.all([
    source.read('planner', repositoryPaths),
    source.read('routing', repositoryPaths),
    source.read('merge', repositoryPaths),
  ]);
  const problems: { file: FactoryFileName; path: string; message: string }[] = [];

  const p = planner.error !== null
    ? { config: SHIPPED_PLANNER_CONFIG, problems: [{ path: '(file)', message: `The planner file can't be read (${planner.error}), so the built-in rules apply.` }] }
    : parsePlannerConfig(planner.raw, SHIPPED_PLANNER_CONFIG);
  problems.push(...p.problems.map((x) => ({ file: 'planner' as const, ...x })));

  const r = routing.error !== null
    ? { config: parseRoutingConfig({}).config, problems: [{ path: '(file)', message: `The routing file can't be read (${routing.error}), so every step uses its role's model.` }] }
    : parseRoutingConfig(routing.raw);
  problems.push(...r.problems.map((x) => ({ file: 'routing' as const, ...x })));

  const m: MergePolicyOrError = merge.error !== null ? { error: merge.error } : parseMergePolicy(merge.raw);
  if ('error' in m) problems.push({ file: 'merge', path: '(file)', message: `The merge policy can't be read (${m.error}), so every pull request asks.` });

  return {
    planner: p.config,
    routing: r.config,
    merge: m,
    problems,
    refs: { planner: planner.ref, routing: routing.ref, merge: merge.ref },
    origins: { planner: planner.origin, routing: routing.origin, merge: merge.origin },
    paths: { planner: planner.path, routing: routing.path, merge: merge.path },
  };
}

/** A source that finds nothing on disk: the shipped files, as the application module binds by default. */
export const SHIPPED_FACTORY_SOURCE: FactoryConfigSourcePort = {
  read: async (name) => ({ name, origin: 'shipped', path: null, raw: SHIPPED_FILES[name], error: null, ref: 'shipped' }),
  write: async () => {
    throw new Error('This daemon has no factory files to write.');
  },
};
