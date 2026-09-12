import type {
  ArtifactManifest, ArtifactRepositoryPort, ArtifactStorePort, LoadedArtifact,
  WorkspaceRepositoryPort,
} from '@tandemise/domain';
import type { ArtifactId, MissionId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError } from '@tandemise/shared';
import type { ArtifactService } from '../services.js';

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
  ) {}

  listByMission(missionId: MissionId): readonly ArtifactManifest[] {
    return this.artifacts.listByMission(missionId);
  }

  async read(id: ArtifactId): Promise<LoadedArtifact> {
    if (this.artifacts.get(id) === undefined) throw TandemiseError.notFound('Artifact', id);
    return this.store.read(id);
  }

  /**
   * Search one workspace, or the whole install when none is given.
   *
   * The desktop opens this screen before a workspace has been chosen, so
   * demanding one turned an empty search box into an error.
   */
  search(workspaceId: WorkspaceId | undefined, query: string): readonly ArtifactManifest[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];
    if (workspaceId !== undefined) return this.artifacts.search(workspaceId, trimmed, SEARCH_LIMIT);
    return this.workspaces
      .list()
      .flatMap((w) => this.artifacts.search(w.id, trimmed, SEARCH_LIMIT))
      .slice(0, SEARCH_LIMIT);
  }
}
