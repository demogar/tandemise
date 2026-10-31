import type { ArtifactRepositoryPort } from '@tandemise/domain';
import type { MissionId } from '@tandemise/shared';

/** A link the mission delivered: a pull request or a branch. */
export interface DeliveryLink {
  readonly kind: 'pr' | 'branch';
  readonly label: string;
  readonly url: string;
}

/**
 * Pull request and branch links from the mission's handoffs, first mention
 * wins. P14's completion comment lists them; the tracker's write-back reads a
 * pull request among them as "a pull request is open" (intake plan Task 9).
 */
export function deliveryLinks(artifacts: Pick<ArtifactRepositoryPort, 'listByMission'>, missionId: MissionId): DeliveryLink[] {
  const out: DeliveryLink[] = [];
  for (const manifest of artifacts.listByMission(missionId)) {
    for (const link of manifest.handoff?.links ?? []) {
      // A workspace link may carry only a path (spec A5), which is never a delivery link to post.
      if (link.url === undefined) continue;
      const branch = /\/tree\//.test(link.url);
      if ((link.kind === 'pr' || branch) && /^https?:\/\//.test(link.url) && !out.some((l) => l.url === link.url)) {
        out.push(link.kind === 'pr'
          ? { kind: 'pr', label: `Pull request (${link.label})`, url: link.url }
          : { kind: 'branch', label: `Branch (${link.label})`, url: link.url });
      }
    }
    for (const ref of manifest.sourceRefs) {
      if (ref.kind === 'github.pr' && /^https?:\/\//.test(ref.value) && !out.some((l) => l.url === ref.value)) {
        out.push({ kind: 'pr', label: `Pull request${ref.label === undefined ? '' : ` (${ref.label})`}`, url: ref.value });
      }
    }
  }
  return out;
}
