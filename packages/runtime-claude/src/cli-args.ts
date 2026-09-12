import { CORE_CAPABILITIES, anyCapabilityMatches } from '@tandemise/domain';
import type { Capability } from '@tandemise/domain';
import type { RunRequest } from '@tandemise/runtimes-core';
import { isPathInside } from '@tandemise/shared';

export const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * Tools Claude Code must not be offered when the corresponding capability was
 * not granted (MVP.md §19.2).
 *
 * This is defence in depth and a UX affordance, not the security boundary: the
 * boundary is Tandemise's policy layer plus the execution target's isolation. A
 * CLI flag is only as trustworthy as the CLI, so it is used to keep an honest
 * agent inside its lane, never to contain a hostile one.
 */
export const CAPABILITY_TOOL_GUARDS: ReadonlyArray<{ capability: Capability; tools: readonly string[] }> = [
  { capability: CORE_CAPABILITIES.shell, tools: ['Bash', 'BashOutput', 'KillShell'] },
  { capability: CORE_CAPABILITIES.filesystemWrite, tools: ['Edit', 'Write', 'NotebookEdit'] },
];

export function disallowedTools(grants: readonly Capability[]): string[] {
  return CAPABILITY_TOOL_GUARDS
    .filter((guard) => !anyCapabilityMatches(grants, guard.capability))
    .flatMap((guard) => guard.tools);
}

/**
 * Chooses the headless permission mode.
 *
 * Headless Claude Code cannot answer an interactive permission prompt: a run
 * that triggers one blocks until its wall-time budget kills it. So the mode is
 * derived from what the assignment already granted:
 *
 *  - write **and** shell granted → `bypassPermissions`. The grant has already
 *    said yes to the two things that prompt, and Tandemise's own policy layer
 *    plus the execution target's workspace isolation are the real gate.
 *  - write granted, shell not → `acceptEdits`. Edits proceed; a shell attempt
 *    still prompts, which is the correct outcome for an ungranted capability.
 *  - neither → `default`. With the write and shell tools already disallowed,
 *    the remaining toolset is read-only and does not prompt.
 *
 * `profile.settings.permissionMode` overrides all of this, because an operator
 * running against a sensitive workspace must be able to be stricter than the
 * grants imply.
 */
export function permissionMode(
  grants: readonly Capability[],
  settings: Readonly<Record<string, unknown>>,
): PermissionMode {
  const configured = settings['permissionMode'];
  if (typeof configured === 'string' && (PERMISSION_MODES as readonly string[]).includes(configured)) {
    return configured as PermissionMode;
  }
  const canWrite = anyCapabilityMatches(grants, CORE_CAPABILITIES.filesystemWrite);
  const canShell = anyCapabilityMatches(grants, CORE_CAPABILITIES.shell);
  if (canWrite && canShell) return 'bypassPermissions';
  if (canWrite) return 'acceptEdits';
  return 'default';
}

/**
 * Prompts above this go on stdin instead of argv. A compiled context pack can
 * be large, and `execve` fails outright past the platform's argument limit -
 * a failure mode that would look like "the runtime is broken" rather than
 * "the prompt is long".
 */
export const MAX_PROMPT_ARG_CHARS = 64 * 1024;

export interface ClaudeInvocation {
  readonly args: readonly string[];
  /** Non-null when the prompt goes on stdin rather than argv. */
  readonly stdin: string | null;
}

/**
 * Builds the full argv for one run. Pure, so the flag mapping can be asserted
 * without spawning anything.
 */
export function buildInvocation(request: RunRequest, resumeSessionRef: string | null): ClaudeInvocation {
  const settings = request.profile.settings;
  const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose'];

  const model = settings['model'];
  if (typeof model === 'string' && model.length > 0) args.push('--model', model);

  args.push('--permission-mode', permissionMode(request.grants, settings));

  const allowed = stringList(settings['allowedTools']);
  if (allowed.length > 0) args.push('--allowed-tools', allowed.join(','));

  const disallowed = [...new Set([...disallowedTools(request.grants), ...stringList(settings['disallowedTools'])])];
  if (disallowed.length > 0) args.push('--disallowed-tools', disallowed.join(','));

  // The working directory is implicit (it is the child's cwd); only additional
  // roots need declaring, and only roots outside it are additional.
  for (const root of request.allowedRoots) {
    if (!isPathInside(request.workingDirectory, root)) args.push('--add-dir', root);
  }

  if (request.mcpConfigPath !== null) {
    // Without --strict-mcp-config the CLI merges the user's own global servers,
    // which would silently hand the run tools no one granted it.
    args.push('--mcp-config', request.mcpConfigPath, '--strict-mcp-config');
  }

  if (resumeSessionRef !== null) args.push('--resume', resumeSessionRef);
  args.push(...stringList(request.profile.args));

  if (request.prompt.length <= MAX_PROMPT_ARG_CHARS) {
    return { args: [...args, request.prompt], stdin: null };
  }
  return { args, stdin: request.prompt };
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}
