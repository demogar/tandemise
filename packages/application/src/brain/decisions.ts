import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import type { Decision } from '@tandemise/domain';
import { slugify } from '@tandemise/shared';
import { BRAIN_DECISIONS } from './layout.js';

/**
 * An accepted decision as a brain file (#51 spec §5). The name comes from the
 * content, never the local id, so two machines writing the same decision
 * produce one file.
 */
export function decisionFileName(d: Pick<Decision, 'title' | 'decision'>): string {
  const hash = createHash('sha256').update(`${d.title}\0${d.decision}`).digest('hex').slice(0, 8);
  return `${slugify(d.title, 40)}-${hash}.md`;
}

export function decisionFile(
  d: Decision,
  opts: { readonly supersedes?: string | null; readonly supersededBy?: string | null; readonly scrub?: (text: string) => string } = {},
): { path: string; content: string } {
  const scrub = opts.scrub ?? ((t: string) => t);
  const front: Record<string, unknown> = {
    title: scrub(d.title),
    status: d.status,
    decidedAt: d.decidedAt,
    supersedes: opts.supersedes ?? null,
  };
  if (opts.supersededBy !== undefined && opts.supersededBy !== null) front['supersededBy'] = opts.supersededBy;
  const alternatives = d.alternatives.length === 0
    ? 'None recorded.'
    : d.alternatives.map((a) => `- **${scrub(a.title)}**: ${scrub(a.summary)}${a.rejectedBecause ? ` Rejected because ${scrub(a.rejectedBecause)}` : ''}`).join('\n');
  const consequences = d.consequences.length === 0 ? 'None recorded.' : d.consequences.map((c) => `- ${scrub(c)}`).join('\n');
  const body = [
    '## Context', '', scrub(d.context.trim()) || 'None recorded.', '',
    '## Decision', '', scrub(d.decision.trim()), '',
    '## Alternatives', '', alternatives, '',
    '## Rationale', '', scrub(d.rationale.trim()) || 'None recorded.', '',
    '## Consequences', '', consequences, '',
  ].join('\n');
  const yaml = stringify(front, { sortMapEntries: true, lineWidth: 0, minContentWidth: 0, indent: 2 });
  return { path: `${BRAIN_DECISIONS}/${decisionFileName(d)}`, content: `---\n${yaml}---\n\n${body}` };
}

/** Every accepted decision of a project as files, with `supersedes` links resolved to file names. */
export function decisionFiles(decisions: readonly Decision[], scrub?: (text: string) => string): { path: string; content: string }[] {
  const byId = new Map(decisions.map((d) => [d.id as string, d]));
  const supersededBy = new Map<string, string>();
  for (const d of decisions) if (d.supersedes !== null && byId.has(d.supersedes)) supersededBy.set(d.supersedes, decisionFileName(d));
  return decisions
    .filter((d) => d.status === 'accepted' || d.status === 'superseded')
    .map((d) => decisionFile(d, {
      supersedes: d.supersedes === null ? null : (byId.has(d.supersedes) ? decisionFileName(byId.get(d.supersedes)!) : null),
      supersededBy: supersededBy.get(d.id) ?? null,
      ...(scrub === undefined ? {} : { scrub }),
    }));
}
