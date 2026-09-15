import type {
  Approval, ArtifactHandoff, ArtifactManifest, ArtifactRepositoryPort, Mission, MissionTask, TaskRepositoryPort, TaskStatus,
} from '@tandemise/domain';
import { asId } from '@tandemise/shared';
import { versionLines } from './artifact-versions.js';

/**
 * The rules that decide which handoff a person sees and whether its `needs`
 * line still applies. The mission feed, the reader and the approval cards all
 * read them from here, so a card, a document and an inbox line never disagree
 * about what is being asked or which artifact speaks for a task.
 */

/** A person is being asked something while the task sits in these, so its `needs` line still applies. */
const ASKING_TASK_STATUSES: readonly TaskStatus[] = ['AWAITING_HUMAN', 'AWAITING_INPUT'];

/**
 * Whether a task still has an open request: a pending approval that asks for
 * a decision (a check waits on nobody), or a status that waits on a person.
 */
export function isTaskAsking(task: Pick<MissionTask, 'status'>, pendingApprovals: readonly Pick<Approval, 'kind'>[]): boolean {
  return pendingApprovals.some((a) => a.kind !== 'check') || ASKING_TASK_STATUSES.includes(task.status);
}

/**
 * Whether the plan still asks for approval. The mission's status is the truth
 * of it: an approval row can outlive a re-plan or a cancel, but a mission past
 * AWAITING_PLAN_APPROVAL is asking nobody to approve its plan.
 */
export function isPlanAsking(mission: Pick<Mission, 'status'>, pendingApprovals: readonly Pick<Approval, 'kind'>[]): boolean {
  return mission.status === 'AWAITING_PLAN_APPROVAL' && pendingApprovals.some((a) => a.kind === 'plan');
}

/**
 * An artifact's handoff as a person should see it now. A legacy row has none
 * and lends its summary as the headline. `needs` is kept only while the
 * request it names is still open: the stored handoff says "Approve the plan to
 * start" forever, and showing that after the plan was approved would ask for
 * something already done.
 */
export function currentHandoff(artifact: ArtifactManifest | undefined, asking: boolean): ArtifactHandoff | null {
  if (artifact === undefined) return null;
  const handoff: ArtifactHandoff | null = artifact.handoff
    ?? (artifact.summary === null ? null : { headline: artifact.summary, points: [], needs: null, changed: [], links: [] });
  if (handoff === null) return null;
  return asking ? handoff : { ...handoff, needs: null };
}

/**
 * The artifact that speaks for a task: the first expected output it produced,
 * else its newest.
 *
 * `live` are the task's current versions; `all` (default: `live`) every
 * version it ever wrote, newest first. The expected type is chosen from `all`,
 * so when the primary output was replaced by another task's fix, the card keeps
 * that output (marked superseded by the caller) instead of quietly promoting a
 * secondary artifact that happens to still be live.
 */
export function primaryArtifact(
  live: readonly ArtifactManifest[],
  expected: readonly string[],
  all: readonly ArtifactManifest[] = live,
): ArtifactManifest | undefined {
  for (const type of expected) {
    const found = live.find((a) => a.type === type) ?? all.find((a) => a.type === type);
    if (found !== undefined) return found;
  }
  return live[0] ?? all[0];
}

/**
 * Version lines per loaded list. A caller that reuses one mission's list for
 * many cards (the feed, or a list of approvals) numbers it once rather than
 * once per card; a fresh read is a new array and is numbered afresh, so this
 * never serves stale lines.
 */
const numbered = new WeakMap<readonly ArtifactManifest[], ReturnType<typeof versionLines>>();
function linesOf(all: readonly ArtifactManifest[]): ReturnType<typeof versionLines> {
  let lines = numbered.get(all);
  if (lines === undefined) {
    lines = versionLines(all);
    numbered.set(all, lines);
  }
  return lines;
}

/**
 * The artifact an approval card should quote.
 *
 * An artifact the card cites is what the person was shown, so it wins, but
 * followed to its live successor: a revision made while the card waited is
 * what they would be approving. Without a cited artifact, a task's card quotes
 * the task's primary live output, the same one its feed card leads with.
 */
export function approvalArtifact(
  deps: {
    readonly artifacts: Pick<ArtifactRepositoryPort, 'get' | 'listByMission'>;
    readonly tasks: Pick<TaskRepositoryPort, 'get'>;
  },
  approval: Approval,
): ArtifactManifest | undefined {
  const cited = approval.evidence.find((e) => e.kind === 'artifact');
  const citedRow = cited === undefined ? undefined : deps.artifacts.get(asId<'ArtifactId'>(cited.value));
  // Set-aside output is no one's output: the card quotes what the task has instead, as if nothing were cited.
  const citedArtifact = (citedRow?.withdrawnAt ?? null) === null ? citedRow : undefined;
  if (citedArtifact === undefined && approval.taskId === null) return undefined;
  const missionId = citedArtifact?.missionId ?? approval.missionId;
  if (missionId === null) return citedArtifact;
  const all = deps.artifacts.listByMission(missionId);
  const lines = linesOf(all);
  const byId = new Map(all.map((a) => [a.id as string, a]));
  if (citedArtifact !== undefined) {
    let current = citedArtifact;
    const seen = new Set<string>();
    for (let next = lines.get(current.id)?.supersededBy ?? null; next !== null && !seen.has(next); next = lines.get(next)?.supersededBy ?? null) {
      seen.add(next);
      current = byId.get(next) ?? current;
    }
    return current;
  }
  const task = approval.taskId === null ? undefined : deps.tasks.get(approval.taskId);
  // Newest first, as the repository lists them, so the primary is the newest of its type.
  const own = all.filter((a) => a.taskId === approval.taskId && lines.get(a.id)?.supersededBy === null);
  return primaryArtifact(own, task?.expectedOutputs ?? []);
}
