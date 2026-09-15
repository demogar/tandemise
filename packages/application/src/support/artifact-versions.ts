import type { ArtifactManifest } from '@tandemise/domain';

export interface VersionLine {
  /** 1-based position along the `supersedes` chain. */
  readonly version: number;
  /** The artifact that replaced this one, or null while it is live. */
  readonly supersededBy: string | null;
}

/**
 * Places each artifact in its line of versions, from the `supersedes`
 * pointers alone.
 *
 * The repository writes the back-pointer in the same transaction as the
 * artifact that declares `supersedes`, so the forward pointers describe the
 * same chain and a mission's list can be numbered without another query. A
 * predecessor outside the given set (another mission's, in principle) simply
 * ends the chain there rather than failing the list.
 */
export function versionLines(artifacts: readonly ArtifactManifest[]): ReadonlyMap<string, VersionLine> {
  const byId = new Map(artifacts.map((a) => [a.id as string, a]));
  const successor = new Map<string, string>();
  for (const a of artifacts) {
    if (a.supersedes !== null) successor.set(a.supersedes, a.id);
  }
  const versions = new Map<string, number>();
  const versionOf = (id: string): number => {
    const known = versions.get(id);
    if (known !== undefined) return known;
    // Walked iteratively, with a guard, so a corrupt cycle cannot recurse forever.
    const chain: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = id;
    let base = 0;
    while (cursor !== null && byId.has(cursor) && !seen.has(cursor)) {
      const cached = versions.get(cursor);
      if (cached !== undefined) { base = cached; break; }
      seen.add(cursor);
      chain.push(cursor);
      cursor = byId.get(cursor)?.supersedes ?? null;
    }
    chain.reverse().forEach((c, i) => versions.set(c, base + i + 1));
    return versions.get(id) ?? 1;
  };
  return new Map(artifacts.map((a) => [a.id as string, { version: versionOf(a.id), supersededBy: successor.get(a.id) ?? null }]));
}
