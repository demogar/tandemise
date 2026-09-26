import type {
  ApprovalRepositoryPort, ArtifactManifest, ArtifactRepositoryPort, ArtifactStorePort, FeedbackRepositoryPort, MemberRepositoryPort,
  MissionRepositoryPort, TaskRepositoryPort, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import type { ArtifactReadView, ArtifactView, MissionArtifactView, OpenRequest } from '@tandemise/api-contract';
import type { ArtifactId, MissionId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError } from '@tandemise/shared';
import type { ArtifactService } from '../services.js';
import type { ArtifactMeasurePort } from '../ports.js';
import { toArtifactView } from '../support/actors.js';
import { versionLines } from '../support/artifact-versions.js';
import { isPlanAsking, isTaskAsking } from '../support/handoff-rules.js';
import { resolveChanges } from '../support/feedback-view.js';
import { missionTakesRounds } from '../support/feedback-rules.js';

/** Search results are a list, not a report; more than this is noise. */
const SEARCH_LIMIT = 50;

/**
 * Reading what the organization produced (MVP.md §15).
 *
 * Metadata comes from the database and bodies from the store, and the two are
 * kept apart on purpose: a mission screen lists thirty manifests without
 * touching the filesystem, and only an opened artifact costs a read.
 */
export class ArtifactServiceImpl implements ArtifactService {
  constructor(
    private readonly artifacts: ArtifactRepositoryPort,
    private readonly store: ArtifactStorePort,
    private readonly workspaces: WorkspaceRepositoryPort,
    private readonly members: MemberRepositoryPort,
    private readonly measure: ArtifactMeasurePort,
    /** Whether a handoff's `needs` is still being asked depends on the mission, the task and its open approvals. */
    private readonly requests: {
      readonly missions: Pick<MissionRepositoryPort, 'get'>;
      readonly tasks: Pick<TaskRepositoryPort, 'get'>;
      readonly approvals: Pick<ApprovalRepositoryPort, 'list'>;
      /** "Changes in vN" links each change to the note it answers. */
      readonly feedback: Pick<FeedbackRepositoryPort, 'listByTask'>;
    },
  ) {}

  /**
   * Superseded versions are hidden unless asked for: a list that shows every
   * revision of every document buries the ones that count.
   */
  listByMission(missionId: MissionId, options: { includeSuperseded?: boolean } = {}): readonly MissionArtifactView[] {
    const all = this.artifacts.listByMission(missionId);
    const lines = versionLines(all);
    return all
      .filter((a) => options.includeSuperseded === true || lines.get(a.id)?.supersededBy === null)
      .map((a) => ({
        ...toArtifactView({ members: this.members }, a),
        version: lines.get(a.id)?.version ?? 1,
        supersededBy: lines.get(a.id)?.supersededBy ?? null,
      }));
  }

  /**
   * The body from the store, the manifest from the database: only the database
   * row knows who wrote it, who answers for it and who put it on record.
   */
  async read(id: ArtifactId): Promise<ArtifactReadView> {
    const row = this.artifacts.get(id);
    if (row === undefined) throw TandemiseError.notFound('Artifact', id);
    const loaded = await this.store.read(id);
    const withdrawnAt = row.withdrawnAt ?? null;
    // Numbered against its own mission's line, the same way the list numbers it,
    // so the reader's "v2" never disagrees with the row it was opened from. The
    // list leaves out set-aside output, so such a row is numbered with itself
    // added: it still follows the version it had replaced.
    const listed = this.artifacts.listByMission(row.missionId);
    const numbered = withdrawnAt === null ? listed : [...listed, row];
    const lines = versionLines(numbered);
    const line = lines.get(id);
    const supersededBy = line?.supersededBy ?? null;
    const stored = { ...loaded.manifest, ...row };
    // Set-aside output was never judged, so nothing it asks is being asked.
    const openRequest = withdrawnAt === null ? this.#openRequest(stored, supersededBy) : null;
    const manifest = {
      ...toArtifactView({ members: this.members }, stored),
      // The same `needs` rule the feed applies, so the document never asks for what its card no longer does.
      handoff: stored.handoff && openRequest === null ? { ...stored.handoff, needs: null } : stored.handoff ?? null,
      version: line?.version ?? 1,
      supersededBy,
    };
    // The switcher's line is this task's output of this type: another task's
    // version of the same type is a different document, whatever supersedes says.
    // A status report (P10) has no task: its line is every report of the project.
    const versionLine = row.taskId === null
      ? (row.type === 'StatusReport' ? numbered.filter((a) => a.taskId === null && a.type === row.type) : [row])
      : numbered.filter((a) => a.taskId === row.taskId && a.type === row.type);
    const versions = versionLine
      .map((a) => ({ artifactId: a.id as string, version: lines.get(a.id)?.version ?? 1, round: a.round ?? null, createdAt: a.createdAt }))
      .sort((a, b) => a.version - b.version || a.createdAt.localeCompare(b.createdAt));
    const notes = row.taskId === null ? [] : this.requests.feedback.listByTask(row.taskId);
    const changes = resolveChanges({ members: this.members }, stored.handoff, new Map(notes.map((i) => [i.id as string, i])));
    // The same signal FeedCard uses: a wait step reads no notes, and a cancelled mission takes no more rounds.
    const task = row.taskId === null ? null : this.requests.tasks.get(row.taskId);
    const mission = this.requests.missions.get(row.missionId);
    const canRequestChanges = task !== null && task !== undefined && task.executor !== 'wait' && mission !== undefined && missionTakesRounds(mission);
    const rounds = { withdrawnAt, round: row.round ?? null, versions, changes, canRequestChanges };
    // Only Markdown has headings; a JSON or binary body has no appendix to find.
    if (manifest.mediaType !== 'text/markdown') return { manifest, body: loaded.body, appendixWords: null, split: null, openRequest, ...rounds };
    const { main, appendix } = this.measure.splitAppendix(loaded.body);
    if (appendix === null) return { manifest, body: loaded.body, appendixWords: null, split: null, openRequest, ...rounds };
    const { appendixWords } = this.measure.measure(manifest.type, loaded.body);
    return { manifest, body: loaded.body, appendixWords, split: { main, appendix }, openRequest, ...rounds };
  }

  /**
   * The request an artifact's `needs` names, while it is still open, and who
   * it waits on; null once nothing is asked. A replaced version asks for
   * nothing: its successor carries whatever is still needed.
   */
  #openRequest(artifact: ArtifactManifest, supersededBy: string | null): OpenRequest | null {
    if (supersededBy !== null || !artifact.handoff?.needs) return null;
    const mission = this.requests.missions.get(artifact.missionId);
    if (mission === undefined) return null;
    const pending = this.requests.approvals.list({ missionId: mission.id, statuses: ['PENDING'] });
    if (artifact.taskId === null) {
      // Only the plan is written outside a task, and it asks while the plan approval is open.
      if (artifact.type !== 'MissionPlan' || !isPlanAsking(mission, pending)) return null;
      return { kind: 'approval', addresseeIds: pending.find((a) => a.kind === 'plan')?.addressees ?? [] };
    }
    const task = this.requests.tasks.get(artifact.taskId);
    if (task === undefined) return null;
    const own = pending.filter((a) => a.taskId === task.id);
    if (!isTaskAsking(task, own)) return null;
    // A decision holds the work up, so it is what the line waits on; a check waits on nobody.
    const asked = own.find((a) => a.kind !== 'check');
    if (asked !== undefined) return { kind: 'approval', addresseeIds: asked.addressees ?? [] };
    if (task.status === 'AWAITING_HUMAN') {
      return {
        kind: 'person_step',
        assigneeId: task.assigneeId ?? null,
        claimableIds: task.staffing?.claimable ?? [],
        escalatedToIds: task.staffing?.escalatedTo ?? [],
      };
    }
    // A question with no card on record is for whoever reads it.
    return { kind: 'approval', addresseeIds: [] };
  }

  /**
   * Search one workspace, or the whole install when none is given.
   *
   * The desktop opens this screen before a workspace has been chosen, so
   * demanding one turned an empty search box into an error.
   */
  search(workspaceId: WorkspaceId | undefined, query: string, options: { includeSuperseded?: boolean } = {}): readonly ArtifactView[] {
    const trimmed = query.trim();
    // No query is "show me what there is": the newest current artifacts, not nothing.
    if (trimmed.length === 0) {
      const recent = workspaceId !== undefined
        ? this.artifacts.listRecent(workspaceId, SEARCH_LIMIT, options)
        : this.workspaces.list().flatMap((w) => this.artifacts.listRecent(w.id, SEARCH_LIMIT, options))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, SEARCH_LIMIT);
      return recent.map((a) => toArtifactView({ members: this.members }, a));
    }
    const found = workspaceId !== undefined
      ? this.artifacts.search(workspaceId, trimmed, SEARCH_LIMIT, options)
      : this.workspaces.list().flatMap((w) => this.artifacts.search(w.id, trimmed, SEARCH_LIMIT, options)).slice(0, SEARCH_LIMIT);
    return found.map((a) => toArtifactView({ members: this.members }, a));
  }
}
