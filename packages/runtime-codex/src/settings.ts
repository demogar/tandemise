import { CORE_CAPABILITIES, RUNTIME_CAPABILITIES, anyCapabilityMatches } from '@tandemise/domain';
import type { AgentEventType, Capability, RuntimeCapability } from '@tandemise/domain';

/**
 * Codex CLI invocation settings, with best-effort defaults.
 *
 * **Every default here is overridable from the Runtimes screen.** That is a
 * deliberate design decision, not laziness: the Codex CLI is not installed on
 * the machine this adapter was written on, its flag surface has moved between
 * releases (`--json` vs `--experimental-json`, `--full-auto` vs
 * `--dangerously-bypass-approvals-and-sandbox`), and hard-coding an unverified
 * flag would mean a user whose Codex disagrees with ours has to wait for a
 * Tandemise release to run anything. Configuration-driven argv means they fix
 * it in the UI in thirty seconds and we correct the default at our leisure.
 *
 * The defaults below follow the documented `codex exec` surface as of writing
 * and should be treated as a starting point, not as verified fact.
 */
export interface CodexSettings {
  /** Non-interactive entry point. `codex exec "<prompt>"`. */
  readonly subcommand: string;
  /** Structured-output flag, or null for plain text. */
  readonly jsonFlag: string | null;
  readonly outputFormat: 'ndjson' | 'text';
  readonly model: string | null;
  readonly modelFlag: string;
  /** Flag that sets the working directory, or null to rely on the child's cwd. */
  readonly workingDirectoryFlag: string | null;
  /** `read-only` | `workspace-write` | `danger-full-access`, or null to omit. */
  readonly sandboxMode: string | null;
  readonly sandboxFlag: string;
  /** Appended verbatim before the prompt. The escape hatch for anything else. */
  readonly extraArgs: readonly string[];
  readonly promptVia: 'arg' | 'stdin';
  readonly versionArgs: readonly string[];
  /** Subcommand words used by `resume()`, e.g. `['exec', 'resume']`. */
  readonly resumeSubcommand: readonly string[];
  /** Overrides merged over the built-in Codex event table. */
  readonly eventTypes: Readonly<Record<string, AgentEventType | 'ignore'>>;
  readonly capabilities: readonly RuntimeCapability[] | null;
}

export const CODEX_INSTALL_HINT = 'Install it with `npm i -g @openai/codex`, then set the executable path on this profile.';

/**
 * What Codex is advertised as able to do (MVP.md §10.5).
 *
 * `session_resume` is deliberately absent even though `codex exec resume`
 * exists: routing acts on these flags, and this adapter has never been run
 * against a real binary, so claiming resume would risk the scheduler choosing
 * Codex *because* it can resume and then finding it cannot. A profile can add
 * it via `settings.capabilities` once the user has confirmed their version.
 */
export const CODEX_CAPABILITIES: readonly RuntimeCapability[] = [
  'reasoning', 'shell', 'filesystem', 'git', 'structured_output', 'tool_calling',
];

const DEFAULTS = {
  subcommand: 'exec',
  jsonFlag: '--json',
  modelFlag: '-m',
  workingDirectoryFlag: '-C',
  sandboxFlag: '--sandbox',
  versionArgs: ['--version'],
  resumeSubcommand: ['exec', 'resume'],
} as const;

export function parseCodexSettings(settings: Readonly<Record<string, unknown>>): CodexSettings {
  const jsonFlag = settings['jsonFlag'] === null
    ? null
    : optionalString(settings['jsonFlag']) ?? DEFAULTS.jsonFlag;
  const declaredFormat = settings['outputFormat'];

  return {
    subcommand: optionalString(settings['subcommand']) ?? DEFAULTS.subcommand,
    jsonFlag,
    // The format follows the flag unless the user says otherwise: asking for
    // `--json` and then parsing plain text is never what anyone meant.
    outputFormat: declaredFormat === 'text' || declaredFormat === 'ndjson'
      ? declaredFormat
      : (jsonFlag === null ? 'text' : 'ndjson'),
    model: optionalString(settings['model']) ?? null,
    modelFlag: optionalString(settings['modelFlag']) ?? DEFAULTS.modelFlag,
    workingDirectoryFlag: settings['workingDirectoryFlag'] === null
      ? null
      : optionalString(settings['workingDirectoryFlag']) ?? DEFAULTS.workingDirectoryFlag,
    sandboxMode: optionalString(settings['sandboxMode']) ?? null,
    sandboxFlag: optionalString(settings['sandboxFlag']) ?? DEFAULTS.sandboxFlag,
    extraArgs: stringList(settings['extraArgs']),
    promptVia: settings['promptVia'] === 'stdin' ? 'stdin' : 'arg',
    versionArgs: settings['versionArgs'] === undefined
      ? DEFAULTS.versionArgs
      : stringList(settings['versionArgs']),
    resumeSubcommand: settings['resumeSubcommand'] === undefined
      ? DEFAULTS.resumeSubcommand
      : stringList(settings['resumeSubcommand']),
    eventTypes: parseEventTypes(settings['eventTypes']),
    capabilities: parseCapabilities(settings['capabilities']),
  };
}

/**
 * Maps grants onto a Codex sandbox mode, mirroring how the Claude adapter maps
 * them onto a permission mode.
 *
 * Codex has no "may write but may not execute" mode, so a write grant implies
 * `workspace-write`; the containment that matters is the execution target's
 * workspace isolation, not this flag. `danger-full-access` is never derived -
 * a user who genuinely wants it must ask for it by name in `sandboxMode`.
 */
export function sandboxModeFor(grants: readonly Capability[]): string {
  const canWrite = anyCapabilityMatches(grants, CORE_CAPABILITIES.filesystemWrite);
  const canShell = anyCapabilityMatches(grants, CORE_CAPABILITIES.shell);
  return canWrite || canShell ? 'workspace-write' : 'read-only';
}

function parseEventTypes(value: unknown): Readonly<Record<string, AgentEventType | 'ignore'>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, AgentEventType | 'ignore'> = {};
  for (const [from, to] of Object.entries(value as Record<string, unknown>)) {
    if (typeof to === 'string' && (to === 'ignore' || CANONICAL_TYPES.has(to))) {
      out[from] = to as AgentEventType | 'ignore';
    }
  }
  return out;
}

const CANONICAL_TYPES: ReadonlySet<string> = new Set<AgentEventType>([
  'message', 'thinking_summary', 'tool.started', 'tool.completed', 'file.changed',
  'artifact.created', 'approval.requested', 'usage', 'checkpoint', 'completed', 'failed',
]);

function parseCapabilities(value: unknown): readonly RuntimeCapability[] | null {
  if (!Array.isArray(value)) return null;
  const known = new Set<string>(RUNTIME_CAPABILITIES);
  return value.filter((c): c is RuntimeCapability => typeof c === 'string' && known.has(c));
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}
