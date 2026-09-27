/**
 * Capability taxonomy (MVP.md §10.5, §19).
 *
 * Two distinct meanings share this vocabulary and must not be confused:
 *
 *  - A *runtime* capability is descriptive: "this runtime is able to run shell
 *    commands".
 *  - A *grant* is authoritative: "this worker assignment is permitted to run
 *    shell commands, in these paths, until this time".
 *
 * Routing reads the first. Enforcement reads the second. A runtime being
 * capable never implies permission.
 */
export const RUNTIME_CAPABILITIES = [
  'reasoning', 'vision', 'shell', 'filesystem', 'git', 'web', 'browser',
  'mcp', 'structured_output', 'session_resume', 'tool_calling', 'computer_use',
] as const;
export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

/**
 * Permission capabilities are dotted, hierarchical strings. A grant for
 * `github` implies `github.pr.create`; a grant for `github.pr` does not imply
 * `github.issue.create`. See `capabilityMatches`.
 */
export type Capability = string;

export const CORE_CAPABILITIES = {
  repositoryRead: 'repository.read',
  filesystemRead: 'filesystem.read',
  filesystemWrite: 'filesystem.write',
  shell: 'shell.exec',
  git: 'git',
  gitCommit: 'git.commit',
  gitPush: 'git.push',
  testsRun: 'tests.run',
  browser: 'browser',
  browserNavigate: 'browser.navigate',
  desktop: 'desktop',
  githubRead: 'github.read',
  githubPrCreate: 'github.pr.create',
  mcp: 'mcp',
  artifactWrite: 'artifact.write',
  /**
   * Ask the person supervising the mission a question, and wait for the answer.
   *
   * Held by every role. A worker that cannot ask has only two moves when it
   * meets a decision that is not its to make - guess, or stop - and both push
   * the work back onto the user that the role existed to take off them.
   */
  humanAsk: 'human.ask',
  /** Produce a design in a real design tool, rather than describing one. */
  design: 'design',
  /**
   * Work in the tools a connected app provides. Each has a `.read` child that
   * a connector publishes its read-only tools under.
   */
  planning: 'planning',
  database: 'database',
  deploy: 'deploy',
  monitoring: 'monitoring',
} as const;

/**
 * `granted` covers `requested` when it is the same capability or a
 * dot-delimited ancestor of it. `*` is a wildcard for the remaining segments.
 */
export function capabilityMatches(granted: Capability, requested: Capability): boolean {
  if (granted === requested || granted === '*') return true;
  const g = granted.split('.');
  const r = requested.split('.');
  if (g.length > r.length) return false;
  return g.every((seg, i) => seg === '*' || seg === r[i]);
}

export function anyCapabilityMatches(granted: readonly Capability[], requested: Capability): boolean {
  return granted.some((g) => capabilityMatches(g, requested));
}

/**
 * Risk classes (MVP.md §18.2). Ordered least→most consequential; the ordering is
 * load-bearing for "escalate to the highest risk in this batch".
 */
export const RISK_CLASSES = [
  'read', 'write_reversible', 'external_side_effect', 'destructive', 'financial', 'release',
] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export function maxRisk(a: RiskClass, b: RiskClass): RiskClass {
  return RISK_CLASSES.indexOf(a) >= RISK_CLASSES.indexOf(b) ? a : b;
}

/**
 * The directory a worker writes its outputs into, relative to its working
 * directory. The whole hand-off protocol: the prompt names it, the harvester
 * scans it, the `artifact.<Type>.exists` gate measures it, and a runtime that
 * scopes file writes scopes `artifact.write` to it.
 */
export const ARTIFACT_OUT_DIR = '.tandemise/out';

/**
 * What git must ignore under `.tandemise/`: the agents' working files, and this
 * ignore file itself - not the project's setup next to them (workflows, roles,
 * routines), which is meant to be committed (P15).
 *
 * The first version ignored everything (`*` here, `.tandemise/` in
 * `.git/info/exclude`), so a workflow file added after any planning run was
 * silently ignored by git. The legacy values are kept so the harvester and the
 * setup export can recognise Tandemise's own old lines, and only those.
 */
export const TANDEMISE_IGNORE_FILE = '.tandemise/.gitignore';
export const TANDEMISE_IGNORE_BODY =
  '# Written by Tandemise. Agent working files never belong in the diff;\n'
  + '# your setup next to them (workflows, roles, routines) does.\n/out/\n/.gitignore\n';
export const LEGACY_TANDEMISE_IGNORE_BODY = '# Written by Tandemise. Agent working files never belong in the diff.\n*\n';
export const TANDEMISE_EXCLUDE_ENTRY = '.tandemise/out/';
export const LEGACY_TANDEMISE_EXCLUDE_ENTRY = '.tandemise/';
