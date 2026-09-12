import { RUNTIME_CAPABILITIES } from '@tandemise/domain';
import type { AgentEventType, RuntimeCapability } from '@tandemise/domain';
import { Err, Ok, TandemiseError } from '@tandemise/shared';
import type { Result } from '@tandemise/shared';

export const PROMPT_PLACEHOLDER = '{{prompt}}';
export const CWD_PLACEHOLDER = '{{cwd}}';

/**
 * How a raw NDJSON record from a third-party CLI is read as an `AgentEvent`.
 *
 * Field *names* are configurable, event *types* are not: a mapping may only
 * target a member of the canonical union (MVP.md §10.4). That asymmetry is the
 * point - users may describe any CLI's JSON, but no configuration can invent a
 * new event kind for the timeline to render.
 */
export interface GenericEventMap {
  readonly typeField: string;
  /** Raw type → canonical type, or `'ignore'` to drop the record entirely. */
  readonly types: Readonly<Record<string, AgentEventType | 'ignore'>>;
  readonly textField: string;
  readonly toolField: string;
  readonly pathField: string;
  readonly outcomeField: string;
  readonly sessionField: string;
}

export const DEFAULT_EVENT_MAP: GenericEventMap = {
  typeField: 'type',
  types: {},
  textField: 'text',
  toolField: 'tool',
  pathField: 'path',
  outcomeField: 'outcome',
  sessionField: 'session_id',
};

export interface GenericCliSettings {
  readonly command: string;
  /** `{{prompt}}` and `{{cwd}}` are substituted per run. */
  readonly args: readonly string[];
  readonly promptVia: 'arg' | 'stdin';
  readonly outputFormat: 'ndjson' | 'text';
  readonly eventMap: GenericEventMap;
  readonly versionArgs: readonly string[];
  readonly capabilities: readonly RuntimeCapability[];
}

/** Runtimes wired purely by configuration make no promises we can verify. */
const DEFAULT_GENERIC_CAPABILITIES: readonly RuntimeCapability[] = ['reasoning', 'tool_calling'];

/**
 * Reads a `RuntimeProfile.settings` bag into a validated configuration.
 *
 * Returns a `Result` rather than throwing: a half-configured profile is an
 * expected state in a settings UI, and the message needs to reach the user who
 * is editing it.
 */
export function parseGenericCliSettings(
  settings: Readonly<Record<string, unknown>>,
): Result<GenericCliSettings, TandemiseError> {
  const command = settings['command'];
  if (typeof command !== 'string' || command.trim().length === 0) {
    return Err(TandemiseError.validation('Generic CLI runtime needs a `command` setting'));
  }

  const promptVia = settings['promptVia'] ?? 'arg';
  if (promptVia !== 'arg' && promptVia !== 'stdin') {
    return Err(TandemiseError.validation(`Unknown promptVia '${String(promptVia)}' (expected 'arg' or 'stdin')`));
  }

  const outputFormat = settings['outputFormat'] ?? 'text';
  if (outputFormat !== 'ndjson' && outputFormat !== 'text') {
    return Err(TandemiseError.validation(`Unknown outputFormat '${String(outputFormat)}' (expected 'ndjson' or 'text')`));
  }

  const eventMap = parseEventMap(settings['eventMap']);
  if (!eventMap.ok) return eventMap;

  return Ok({
    command: command.trim(),
    args: stringList(settings['args']),
    promptVia,
    outputFormat,
    eventMap: eventMap.value,
    versionArgs: settings['versionArgs'] === undefined ? ['--version'] : stringList(settings['versionArgs']),
    capabilities: parseCapabilities(settings['capabilities']) ?? DEFAULT_GENERIC_CAPABILITIES,
  });
}

function parseEventMap(value: unknown): Result<GenericEventMap, TandemiseError> {
  if (value === undefined || value === null) return Ok(DEFAULT_EVENT_MAP);
  if (typeof value !== 'object' || Array.isArray(value)) {
    return Err(TandemiseError.validation('`eventMap` must be an object'));
  }
  const raw = value as Record<string, unknown>;
  const types: Record<string, AgentEventType | 'ignore'> = {};
  const declared = raw['types'];
  if (declared !== undefined) {
    if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
      return Err(TandemiseError.validation('`eventMap.types` must be an object'));
    }
    for (const [from, to] of Object.entries(declared as Record<string, unknown>)) {
      if (typeof to !== 'string' || !(to === 'ignore' || CANONICAL_EVENT_TYPES.has(to))) {
        return Err(TandemiseError.validation(
          `eventMap.types['${from}'] must be 'ignore' or a canonical AgentEvent type`,
          { got: to, allowed: [...CANONICAL_EVENT_TYPES] },
        ));
      }
      types[from] = to as AgentEventType | 'ignore';
    }
  }
  return Ok({
    typeField: field(raw['typeField'], DEFAULT_EVENT_MAP.typeField),
    types,
    textField: field(raw['textField'], DEFAULT_EVENT_MAP.textField),
    toolField: field(raw['toolField'], DEFAULT_EVENT_MAP.toolField),
    pathField: field(raw['pathField'], DEFAULT_EVENT_MAP.pathField),
    outcomeField: field(raw['outcomeField'], DEFAULT_EVENT_MAP.outcomeField),
    sessionField: field(raw['sessionField'], DEFAULT_EVENT_MAP.sessionField),
  });
}

/**
 * Mirrors the `AgentEvent` union. `raw` is omitted deliberately: unmapped lines
 * already become `raw` events, so allowing it as a target would only let a
 * configuration relabel content it had failed to understand.
 */
const CANONICAL_EVENT_TYPES: ReadonlySet<string> = new Set<AgentEventType>([
  'message', 'thinking_summary', 'tool.started', 'tool.completed', 'file.changed',
  'artifact.created', 'approval.requested', 'usage', 'checkpoint', 'completed', 'failed',
]);

function field(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function parseCapabilities(value: unknown): readonly RuntimeCapability[] | null {
  if (!Array.isArray(value)) return null;
  const known = new Set<string>(RUNTIME_CAPABILITIES);
  return value.filter((c): c is RuntimeCapability => typeof c === 'string' && known.has(c));
}

export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** Substitutes the per-run placeholders, leaving unknown `{{...}}` untouched. */
export function substitute(template: string, values: Readonly<Record<string, string>>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) out = out.split(`{{${key}}}`).join(value);
  return out;
}
