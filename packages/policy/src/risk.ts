import { maxRisk, type Capability, type RiskClass } from '@tandemise/domain';
import { classifyShellCommand, type ShellClassification, type ShellContext } from './shell.js';

/**
 * Maps a requested action onto the risk taxonomy of MVP.md §18.2.
 *
 * Two inputs contribute. The *capability* gives a floor: `github.pr.create` is
 * at least an external side effect no matter how it is invoked. The *command*,
 * when the action is a shell execution, can escalate that floor - `shell.exec`
 * alone says nothing useful, and the difference between `npm test` and
 * `sudo rm -rf /` lives entirely in the argument string.
 *
 * Classification never *lowers* risk. That direction is the one an attacker
 * would want.
 */
export interface RiskRequest {
  readonly capability: Capability;
  /** Present when the action is a shell execution. */
  readonly command?: string;
  readonly shell?: ShellContext;
}

export interface RiskAssessment {
  readonly risk: RiskClass;
  readonly reason: string;
  readonly shell?: ShellClassification;
}

/**
 * Longest-prefix capability → risk table. Entries are matched by dotted-segment
 * prefix, so `github.pr.create` finds the `github.pr.create` entry before the
 * `github` entry.
 */
const CAPABILITY_RISK: ReadonlyArray<readonly [Capability, RiskClass]> = [
  // Reads.
  ['repository.read', 'read'],
  ['filesystem.read', 'read'],
  ['github.read', 'read'],
  ['analytics.read', 'read'],
  ['finance.read', 'read'],
  ['browser.navigate', 'read'],
  ['web.read', 'read'],
  ['mcp.read', 'read'],
  // Asking the supervising human a question changes nothing and is answered by
  // the person who would otherwise be approving it. Classifying it any higher
  // would mean a worker needed permission to request permission.
  ['human.ask', 'read'],

  // Reversible local work.
  ['filesystem.write', 'write_reversible'],
  ['artifact.write', 'write_reversible'],
  ['shell.exec', 'write_reversible'],
  ['tests.run', 'write_reversible'],
  ['git', 'write_reversible'],
  ['git.commit', 'write_reversible'],
  ['git.branch.create', 'write_reversible'],
  ['browser', 'write_reversible'],
  ['desktop', 'write_reversible'],
  ['mcp', 'write_reversible'],
  // Composing a design. The draft itself is reversible; publishing it to a
  // vendor is a separate capability that classifies higher (see `figma.write`).
  ['design', 'write_reversible'],

  // Things that escape the machine.
  ['git.push', 'external_side_effect'],
  ['github', 'external_side_effect'],
  ['github.pr.create', 'external_side_effect'],
  ['github.issue.create', 'external_side_effect'],
  ['github.comment', 'external_side_effect'],
  ['figma.write', 'external_side_effect'],
  ['web.write', 'external_side_effect'],
  ['email.send', 'external_side_effect'],

  // Irreversible.
  ['git.push.force', 'destructive'],
  ['git.branch.delete', 'destructive'],
  ['github.branch.delete', 'destructive'],
  ['github.repo.delete', 'destructive'],
  ['secrets.read', 'destructive'],
  ['data.delete', 'destructive'],

  // Release / production.
  ['release', 'release'],
  ['deploy', 'release'],
  ['github.merge', 'release'],
  ['github.pr.merge', 'release'],
  ['github.release.create', 'release'],
  ['package.publish', 'release'],

  // Excluded in v0.1.
  ['financial', 'financial'],
  ['payment', 'financial'],
  ['billing', 'financial'],
  ['refund', 'financial'],
  ['finance.write', 'financial'],
];

/** `granted`-style prefix test, but for table lookup rather than authorisation. */
function prefixCovers(entry: Capability, capability: Capability): boolean {
  if (entry === capability) return true;
  return capability.startsWith(`${entry}.`);
}

export function riskForCapability(capability: Capability): RiskClass {
  let best: { entry: Capability; risk: RiskClass } | undefined;
  for (const [entry, risk] of CAPABILITY_RISK) {
    if (!prefixCovers(entry, capability)) continue;
    if (!best || entry.length > best.entry.length) best = { entry, risk };
  }
  // An unmapped capability is not assumed harmless. `write_reversible` keeps it
  // out of the auto-allow-everything lane without demanding approval for every
  // new read-only integration someone adds.
  return best?.risk ?? 'write_reversible';
}

/**
 * The context assumed when a caller supplies a command but no shell context.
 * Nothing is writable and nothing is a known workspace path, so any operand the
 * classifier examines is treated as pointing outside the sandbox.
 */
const NO_SHELL_CONTEXT: ShellContext = { writableRoots: [], cwd: '/' };

export interface RiskClassifier {
  classify(request: RiskRequest): RiskAssessment;
}

export function createRiskClassifier(): RiskClassifier {
  return {
    classify(request: RiskRequest): RiskAssessment {
      const base = riskForCapability(request.capability);
      if (request.command === undefined) {
        return { risk: base, reason: `capability '${request.capability}' is classified ${base}` };
      }
      // A command supplied without its shell context used to be discarded
      // entirely, so a caller that forgot one optional field got a *weaker*
      // decision than one that passed it - exactly backwards. Classify against
      // an empty context instead: with no writable roots every path operand
      // reads as outside the workspace, which is the conservative reading.
      const shell = classifyShellCommand(request.command, request.shell ?? NO_SHELL_CONTEXT);
      const risk = maxRisk(base, shell.risk);
      const reason = risk === shell.risk && shell.risk !== base
        ? `shell command escalated to ${risk}: ${shell.reason}`
        : `capability '${request.capability}' is classified ${base}`;
      return { risk, reason, shell };
    },
  };
}
