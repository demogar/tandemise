import { parse as parseYaml, stringify } from 'yaml';
import { z } from 'zod';

/**
 * The brain repository's layout (#51 spec §1). One git repository per
 * project: the factory definition under `factory/` (the P15 setup tree), the
 * project's memory under `memory/`, vendored skills under `skills/`, and the
 * promotion evals under `evals/`, which no agent ever reads.
 */
export const BRAIN_MANIFEST = 'brain.yaml';
export const BRAIN_README = 'README.md';
export const BRAIN_GITATTRIBUTES_FILE = '.gitattributes';
export const BRAIN_FACTORY = 'factory';
export const BRAIN_SKILLS = 'skills';
export const BRAIN_RULES = 'memory/rules';
export const BRAIN_DECISIONS = 'memory/decisions';
export const BRAIN_LEDGER = 'memory/ledger';
export const BRAIN_EVALS = 'evals';
/** A second guard for ledger files when a person rebases by hand (spec §9). */
export const BRAIN_GITATTRIBUTES = 'memory/ledger/** merge=union\n';

export interface BrainManifest {
  readonly version: 1;
  readonly project: string;
  readonly repositories: readonly { readonly name: string; readonly remote: string }[];
  readonly promotion: {
    readonly autoApply: 'off' | 'small';
    readonly minHelpful: number;
    readonly minMissions: number;
  };
  readonly humanEdits: 'direct' | 'pr';
}

const manifestSchema = z.object({
  version: z.literal(1),
  project: z.string().min(1),
  repositories: z.array(z.object({ name: z.string().min(1), remote: z.string().min(1) })).default([]),
  promotion: z.object({
    autoApply: z.enum(['off', 'small']).default('off'),
    minHelpful: z.number().int().min(1).default(3),
    minMissions: z.number().int().min(1).default(2),
  }).default({}),
  humanEdits: z.enum(['direct', 'pr']).default('direct'),
});

export function readBrainManifest(text: string): { manifest: BrainManifest } | { problem: string } {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return { problem: `brain.yaml isn't valid YAML: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') ?? '';
    return { problem: `brain.yaml: ${where ? `${where} ` : ''}${issue?.message ?? 'is not valid'}` };
  }
  return { manifest: parsed.data as BrainManifest };
}

/** Same YAML options as the setup codec, so the file is byte-stable. */
export function renderBrainManifest(m: BrainManifest): string {
  return stringify(
    {
      version: m.version,
      project: m.project,
      repositories: m.repositories.map((r) => ({ name: r.name, remote: r.remote })),
      promotion: { ...m.promotion },
      humanEdits: m.humanEdits,
    },
    { sortMapEntries: true, lineWidth: 0, minContentWidth: 0, indent: 2 },
  );
}

/**
 * A remote as people name it, never as a URL: `github.com/<owner>/<name>`.
 * Local paths and file URLs pass through unchanged (a local-only brain).
 */
export function remoteOf(url: string): string {
  const trimmed = url.trim();
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (https) return `${https[1]}/${https[2]}`;
  return trimmed;
}
