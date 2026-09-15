import type {
  Approval, ArtifactManifest, ArtifactRepositoryPort, MemberRepositoryPort, MissionRepositoryPort, MissionTask, RoleRepositoryPort, RunRepositoryPort,
  TaskRepositoryPort,
} from '@tandemise/domain';
import type { ApprovalView } from '@tandemise/api-contract';
import { actorRef, actorRefs } from './actors.js';
import { positionOf } from '../engine/reviews.js';
import { approvalArtifact } from './handoff-rules.js';

/**
 * Only the reads a card needs, so a projection that has already loaded a
 * mission's rows can hand in maps instead of paying a query per card.
 */
export interface ApprovalViewDeps {
  readonly missions: Pick<MissionRepositoryPort, 'get'>;
  readonly tasks: Pick<TaskRepositoryPort, 'get'>;
  readonly roles: Pick<RoleRepositoryPort, 'get'>;
  readonly runs: Pick<RunRepositoryPort, 'listByTask'>;
  readonly members: Pick<MemberRepositoryPort, 'get'>;
  /**
   * Optional so a caller that only needs names can still build a card; the
   * card then simply has no headline.
   */
  readonly artifacts?: Pick<ArtifactRepositoryPort, 'get' | 'listByMission'>;
}

/**
 * An approval with the three names a human needs to answer it.
 *
 * Shared rather than duplicated because the approval inbox and the mission
 * screen show the same card, and a card that reads "Approve the output of
 * implement?" in one place and names the mission in the other is the kind of
 * inconsistency that makes a user distrust both.
 */
export function toApprovalView(deps: ApprovalViewDeps, approval: Approval): ApprovalView {
  const mission = approval.missionId === null ? undefined : deps.missions.get(approval.missionId);
  const task = approval.taskId === null ? undefined : deps.tasks.get(approval.taskId);
  const role = task === undefined ? undefined : deps.roles.get(task.roleId, approval.workspaceId);
  return {
    approval,
    missionTitle: mission?.title ?? null,
    taskTitle: task?.title ?? null,
    roleName: role?.name ?? task?.roleId ?? null,
    revisable: task !== undefined && isOutputApproval(approval, task, deps.runs),
    addressees: actorRefs(deps, approval.addressees),
    decidedByRef: actorRef(deps, approval.decidedBy),
    recordedByRef: actorRef(deps, approval.recordedBy),
    escalationLevel: approval.escalationLevel ?? 0,
    headline: evidenceHeadline(deps, approval),
  };
}

/**
 * Many cards at once, for a list. A card's headline reads its mission's
 * artifacts, and an inbox or approvals history is mostly cards from the same
 * few missions, so each mission's artifacts are read once for the whole list
 * instead of once per card. The cache lives only for this call: the next
 * request reads the record again, as every projection does.
 */
export function toApprovalViews(deps: ApprovalViewDeps, approvals: readonly Approval[]): readonly ApprovalView[] {
  const shared = deps.artifacts === undefined ? deps : { ...deps, artifacts: missionArtifactCache(deps.artifacts) };
  return approvals.map((a) => toApprovalView(shared, a));
}

/**
 * `listByMission` remembered per mission, and `get` answered from any mission
 * already loaded: a cited artifact almost always belongs to the card's own
 * mission, so after the first card it costs no query either.
 */
function missionArtifactCache(artifacts: Pick<ArtifactRepositoryPort, 'get' | 'listByMission'>): Pick<ArtifactRepositoryPort, 'get' | 'listByMission'> {
  const byMission = new Map<string, readonly ArtifactManifest[]>();
  const byId = new Map<string, ArtifactManifest>();
  return {
    get: (id) => byId.get(id) ?? artifacts.get(id),
    listByMission: (missionId, type) => {
      // A typed list is a different question; nothing here asks it, so it is not worth a second cache.
      if (type !== undefined) return artifacts.listByMission(missionId, type);
      let list = byMission.get(missionId);
      if (list === undefined) {
        list = artifacts.listByMission(missionId);
        byMission.set(missionId, list);
        for (const a of list) byId.set(a.id, a);
      }
      return list;
    },
  };
}

/**
 * The headline of the artifact the card is about, chosen by the rule the feed
 * uses, falling back to a legacy artifact's summary as the reader does.
 */
function evidenceHeadline(deps: ApprovalViewDeps, approval: Approval): string | null {
  if (deps.artifacts === undefined) return null;
  const artifact = approvalArtifact({ artifacts: deps.artifacts, tasks: deps.tasks }, approval);
  return artifact?.handoff?.headline ?? artifact?.summary ?? null;
}

/**
 * Whether this card asks "do you accept this task's output?" - the only kind
 * where Request changes (or, on a card from before it, a reject with a note)
 * starts the task's next round.
 *
 * A start approval, a tool approval and an output approval are all `action`
 * cards on the same task. They are told apart from the record rather than by a
 * marker on the card: an output approval is pending while its task waits in
 * AWAITING_APPROVAL, and was created after that task's latest run began (a start
 * approval predates the run). A tool approval is answered while the task is
 * still RUNNING. One rule, used by the service that acts on the decision and by
 * the view that describes it, so the card never promises what will not happen.
 */
export function isOutputApproval(approval: Approval, task: MissionTask, runs: Pick<RunRepositoryPort, 'listByTask'>): boolean {
  if (approval.kind !== 'action' && approval.kind !== 'release') return false;
  if (task.status !== 'AWAITING_APPROVAL' && approval.status === 'PENDING') return false;
  return !isStartApproval(approval, task, runs);
}

/**
 * Created before the attempt's run row existed ⇒ it gated the start. A card
 * that carries its place in the review pipeline is a review, whatever the runs
 * say: a person's step is reviewed with no run behind it at all.
 */
export function isStartApproval(approval: Approval, task: MissionTask, runs: Pick<RunRepositoryPort, 'listByTask'>): boolean {
  if (positionOf(approval) !== null) return false;
  const latest = [...runs.listByTask(task.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (latest === undefined) return true;
  return approval.createdAt <= latest.startedAt;
}
