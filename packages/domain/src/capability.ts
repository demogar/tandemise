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
